// Single-pass JSON-to-JSON CSV transducer for csv-reader 1.0.0 (rewrite).
//
// Unlike v3/v4, this never unescapes the text and never re-escapes the
// output: the CSV state machine runs DIRECTLY on the raw JSON span of each
// case's text value, and clean raw spans are copied verbatim into the
// output JSON string. That is valid because the scorer compares answers
// by JSON value (canonical form), so the output's escaping need not match
// JSON.stringify byte-for-byte; it only has to decode to the same value
// (and be deterministic, since the harness requires the two executions
// to match byte for byte).
//
// Why verbatim copying is value-correct: inside a JSON string, the raw
// bytes are printable ASCII (except '"' and '\', which never appear raw
// in a span) and UTF-8 multibyte sequences, all of which are legal JSON
// string bytes as they stand. An escape sequence's decoded char is
// handled by the state machine; when it is content, the raw escape bytes
// themselves are the correct output escape (\" \\ \/ \b \f \n \t
// \uXXXX all decode to the same value in the output). The only
// substitutions are where the CSV semantics transform the value:
//   - a doubled quote "" inside a quoted field -> one quote (emit one \")
//   - a CR (or CRLF) inside a quoted field -> read as LF (emit \n)
//   - a lone CR outside quotes -> dropped (stray_cr)
//   - a BOM (U+FEFF) at the very start of the text -> dropped
// Everything else is a verbatim bulk copy, found by SIMD scans.
//
// Memory (bump-allocated from the stub heap in setup()):
//   inBuf      input bytes [0, N)
//   scratchBuf per-record scratch for long-row extra field values
//   descBuf    extra-field descriptors (scratch ranges), 16 bytes each
//   errBuf     the current case's errors JSON fragments
//   tmpBuf     64 bytes: JSON key buffer + itoa temp
//   outBuf     output; extends to the end of memory, grown as needed
//
// A field's value is emitted straight to the output (or, past the width,
// to the scratch buffer) as it is parsed. Descriptors are kept ONLY for
// a long row's extra fields; their decoded values sit in the scratch
// buffer, already correctly JSON-escaped.

// ---------- buffers ----------
let inBuf: usize = 0;
let scratchBuf: usize = 0;
let descBuf: usize = 0;
let errBuf: usize = 0;
let tmpBuf: usize = 0;
let outBuf: usize = 0;
let inLen: i32 = 0;
let outPtr: usize = 0;
let outCap: usize = 0;
let errPtr: usize = 0;
let errCount: i32 = 0;
let scratchPtr: usize = 0;
let failed: bool = false;
let debug: i32 = 0;

// Write destination: the output buffer, or the per-record extra scratch.
// The readers write through wByte/wCopy; the record loop flips
// toScratch for fields past the width.
let toScratch: bool = false;
let scrEnd: usize = 0;

// ---------- JSON scanner ----------
let jp: usize = 0;
let jEnd: usize = 0;
let caseTextStart: usize = 0;
let caseTextEnd: usize = 0;
let caseHeader: bool = false;

// ---------- CSV parser (raw span) ----------
let tp: usize = 0;
let tEnd: usize = 0;
let line: i32 = 1;
let recordLine: i32 = 1;
let recordRow: i32 = -1;
let width: i32 = -1;
let rowsEmitted: i32 = 0;
let columnsDone: bool = false;
let headerFlag: bool = false;
let descCount: i32 = 0;
let fieldCount: i32 = 0;
let lastQuoted: bool = false;
let fEnded: i32 = 0; // 0=COMMA, 1=LINE_BREAK, 2=END
let addedAny: bool = false;

// Fused parse+emit: whether this record is the case's first record
// (width not yet known), and whether its first field was empty.
let recFirst: bool = false;
let firstFieldEmpty: bool = false;

// Peeked decoded-char kind (see peekKind).
let peekLen: usize = 0;
const PK_CONTENT: i32 = 0;
const PK_COMMA: i32 = 1;
const PK_LF: i32 = 2;
const PK_CR: i32 = 3;
const PK_QUOTE: i32 = 4;
const PK_END: i32 = 5;

const DESC_BYTES: usize = 4 * 1024 * 1024;
const DESC_CAP: i32 = 262144; // 4 MiB / 16 bytes per descriptor
const ERR_BYTES: usize = 12 * 1024 * 1024;

// ---------- setup / exports ----------

export function setup(inputLen: i32): usize {
  inLen = inputLen;
  const n = <usize>inputLen;
  inBuf = heap.alloc(n);
  scratchBuf = heap.alloc(n);
  descBuf = heap.alloc(DESC_BYTES);
  errBuf = heap.alloc(ERR_BYTES);
  tmpBuf = heap.alloc(64);
  outBuf = heap.alloc(16);
  scrEnd = scratchBuf + n;
  return inBuf;
}

export function outputPtr(): usize {
  return outBuf;
}

export function outputLen(): usize {
  return outPtr - outBuf;
}

export function debugCode(): i32 {
  return debug;
}

// ---------- SIMD find helpers ----------

function find1(b1: u8, from: usize, to: usize): usize {
  const v1 = i8x16.splat(b1);
  let p = from;
  while (p < to) {
    const rem = to - p;
    if (rem >= 16) {
      const m = i8x16.bitmask(i8x16.eq(v128.load(p), v1));
      if (m != 0) return p + <usize>i32.ctz(m);
      p += 16;
    } else {
      const m = i8x16.bitmask(i8x16.eq(v128.load(p), v1)) & ((1 << <i32>rem) - 1);
      if (m != 0) return p + <usize>i32.ctz(m);
      return to;
    }
  }
  return to;
}

function find2(b1: u8, b2: u8, from: usize, to: usize): usize {
  const v1 = i8x16.splat(b1);
  const v2 = i8x16.splat(b2);
  let p = from;
  while (p < to) {
    const rem = to - p;
    if (rem >= 16) {
      const v = v128.load(p);
      const m = i8x16.bitmask(v128.or(i8x16.eq(v, v1), i8x16.eq(v, v2)));
      if (m != 0) return p + <usize>i32.ctz(m);
      p += 16;
    } else {
      const v = v128.load(p);
      const m = i8x16.bitmask(v128.or(i8x16.eq(v, v1), i8x16.eq(v, v2))) & ((1 << <i32>rem) - 1);
      if (m != 0) return p + <usize>i32.ctz(m);
      return to;
    }
  }
  return to;
}

// ---------- copy / output helpers ----------

// Copy len bytes with unaligned loads/stores (len < 32); overlapping
// head/tail stores cover the whole range exactly.
function copySmall(dst: usize, src: usize, len: usize): void {
  if (len >= 16) {
    store<u64>(dst, load<u64>(src));
    store<u64>(dst + 8, load<u64>(src + 8));
    store<u64>(dst + len - 16, load<u64>(src + len - 16));
    store<u64>(dst + len - 8, load<u64>(src + len - 8));
  } else if (len >= 8) {
    store<u64>(dst, load<u64>(src));
    store<u64>(dst + len - 8, load<u64>(src + len - 8));
  } else if (len >= 4) {
    store<u32>(dst, load<u32>(src));
    store<u32>(dst + len - 4, load<u32>(src + len - 4));
  } else if (len >= 2) {
    store<u16>(dst, load<u16>(src));
    store<u16>(dst + len - 2, load<u16>(src + len - 2));
  } else if (len == 1) {
    store<u8>(dst, load<u8>(src));
  }
}

function growOut(need: usize): void {
  const have = (memory.size() as usize) << 16;
  if (outPtr + need <= have) {
    outCap = have;
    return;
  }
  const pages = (((outPtr + need - have) + 65535) >> 16) + 256;
  if (memory.grow(<i32>pages) < 0) {
    failed = true;
    debug = 9;
    return;
  }
  outCap = (memory.size() as usize) << 16;
}

// Output-only byte (structural: brackets, commas, separators).
function outByte(b: u8): void {
  if (failed) return;
  if (outPtr >= outCap) growOut(1);
  if (failed) return;
  store<u8>(outPtr, b);
  outPtr++;
}

function outLit(s: string): void {
  for (let i = 0; i < s.length; i++) outByte(<u8>s.charCodeAt(i));
}

function outCopy(src: usize, len: usize): void {
  if (failed || len == 0) return;
  if (outPtr + len > outCap) growOut(len);
  if (failed) return;
  if (len < 32) copySmall(outPtr, src, len);
  else memory.copy(outPtr, src, len);
  outPtr += len;
}

// Destination-aware byte: the output buffer, or the extra scratch when
// toScratch is set (fields past the width).
function wByte(b: u8): void {
  if (failed) return;
  if (toScratch) {
    if (scratchPtr >= scrEnd) {
      failed = true;
      debug = 20;
      return;
    }
    store<u8>(scratchPtr, b);
    scratchPtr++;
    return;
  }
  if (outPtr >= outCap) growOut(1);
  if (failed) return;
  store<u8>(outPtr, b);
  outPtr++;
}

function wCopy(src: usize, len: usize): void {
  if (failed || len == 0) return;
  if (toScratch) {
    if (scratchPtr + len > scrEnd) {
      failed = true;
      debug = 20;
      return;
    }
    if (len < 32) copySmall(scratchPtr, src, len);
    else memory.copy(scratchPtr, src, len);
    scratchPtr += len;
    return;
  }
  if (outPtr + len > outCap) growOut(len);
  if (failed) return;
  if (len < 32) copySmall(outPtr, src, len);
  else memory.copy(outPtr, src, len);
  outPtr += len;
}

// Current destination write position (output or scratch).
function wPos(): usize {
  return toScratch ? scratchPtr : outPtr;
}

function errByte(b: u8): void {
  if (failed) return;
  if (errPtr + 1 > errBuf + ERR_BYTES) {
    failed = true;
    debug = 8;
    return;
  }
  store<u8>(errPtr, b);
  errPtr++;
}

function errCopy(src: usize, len: usize): void {
  if (failed || len == 0) return;
  if (errPtr + len > errBuf + ERR_BYTES) {
    failed = true;
    debug = 8;
    return;
  }
  if (len < 32) copySmall(errPtr, src, len);
  else memory.copy(errPtr, src, len);
  errPtr += len;
}

function errLit(s: string): void {
  for (let i = 0; i < s.length; i++) errByte(<u8>s.charCodeAt(i));
}

function errInt(v: i32): void {
  if (v == 0) {
    errByte(0x30);
    return;
  }
  let n = v;
  let p = tmpBuf + 16;
  let len = 0;
  while (n > 0) {
    store<u8>(p, <u8>(0x30 + (n % 10)));
    p++;
    len++;
    n /= 10;
  }
  for (let i = len - 1; i >= 0; i--) errByte(load<u8>(tmpBuf + 16 + <usize>i));
}

// ---------- hex ----------

function hexVal(b: u8): i32 {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return 0;
}

function hex4(p: usize): i32 {
  return (
    (hexVal(load<u8>(p)) << 12) |
    (hexVal(load<u8>(p + 1)) << 8) |
    (hexVal(load<u8>(p + 2)) << 4) |
    hexVal(load<u8>(p + 3))
  );
}

// ---------- JSON scanner ----------

function jSkipWs(): void {
  while (jp < jEnd) {
    const b = load<u8>(jp);
    if (b == 0x20 || b == 0x09 || b == 0x0a || b == 0x0d) jp++;
    else break;
  }
}

function jSkipString(): void {
  jp++;
  for (;;) {
    const hit = find2(0x22, 0x5c, jp, jEnd);
    if (hit >= jEnd) {
      failed = true;
      debug = 2;
      return;
    }
    if (load<u8>(hit) == 0x22) {
      jp = hit + 1;
      return;
    }
    if (load<u8>(hit + 1) == 0x75) jp = hit + 6;
    else jp = hit + 2;
  }
}

function jSkipValue(): void {
  jSkipWs();
  if (failed || jp >= jEnd) {
    failed = true;
    debug = 3;
    return;
  }
  const b = load<u8>(jp);
  if (b == 0x22) {
    jSkipString();
    return;
  }
  if (b == 0x7b) {
    jp++;
    jSkipWs();
    if (load<u8>(jp) == 0x7d) {
      jp++;
      return;
    }
    for (;;) {
      jSkipWs();
      jSkipString();
      if (failed) return;
      jSkipWs();
      if (load<u8>(jp) != 0x3a) {
        failed = true;
        debug = 3;
        return;
      }
      jp++;
      jSkipValue();
      if (failed) return;
      jSkipWs();
      const c = load<u8>(jp);
      if (c == 0x2c) {
        jp++;
        continue;
      }
      if (c == 0x7d) {
        jp++;
        return;
      }
      failed = true;
      debug = 3;
      return;
    }
  }
  if (b == 0x5b) {
    jp++;
    jSkipWs();
    if (load<u8>(jp) == 0x5d) {
      jp++;
      return;
    }
    for (;;) {
      jSkipValue();
      if (failed) return;
      jSkipWs();
      const c = load<u8>(jp);
      if (c == 0x2c) {
        jp++;
        continue;
      }
      if (c == 0x5d) {
        jp++;
        return;
      }
      failed = true;
      debug = 4;
      return;
    }
  }
  if (b == 0x74) {
    jp += 4;
    return;
  } // true
  if (b == 0x66) {
    jp += 5;
    return;
  } // false
  if (b == 0x6e) {
    jp += 4;
    return;
  } // null
  while (jp < jEnd) {
    const c = load<u8>(jp);
    if (
      (c >= 0x30 && c <= 0x39) ||
      c == 0x2d ||
      c == 0x2b ||
      c == 0x2e ||
      c == 0x65 ||
      c == 0x45
    )
      jp++;
    else break;
  }
}

// Read a JSON object key into tmpBuf, return 1="id", 2="input", 3="text",
// 4="header", 0=other. jp points at the opening quote.
function jReadKey(): i32 {
  jp++;
  let klen: usize = 0;
  for (;;) {
    const hit = find2(0x22, 0x5c, jp, jEnd);
    if (hit >= jEnd) {
      failed = true;
      debug = 5;
      return 0;
    }
    let n = hit - jp;
    if (klen + n > 60) n = 60 - klen;
    if (n > 0) {
      if (n < 32) copySmall(tmpBuf + klen, jp, n);
      else memory.copy(tmpBuf + klen, jp, n);
      klen += n;
    }
    if (load<u8>(hit) == 0x22) {
      jp = hit + 1;
      break;
    }
    const e = load<u8>(hit + 1);
    if (e == 0x75) {
      if (klen < 60) klen += <usize>utf8Encode(tmpBuf + klen, hex4(hit + 2));
      jp = hit + 6;
    } else {
      if (klen < 60) {
        store<u8>(tmpBuf + klen, escChar(e));
        klen++;
      }
      jp = hit + 2;
    }
  }
  if (klen == 2 && load<u16>(tmpBuf) == 0x6469) return 1; // "id"
  if (klen == 5 && load<u32>(tmpBuf) == 0x75706e69 && load<u8>(tmpBuf + 4) == 0x74)
    return 2; // "input"
  if (klen == 4 && load<u32>(tmpBuf) == 0x74786574) return 3; // "text"
  if (klen == 6 && load<u32>(tmpBuf) == 0x64616568 && load<u16>(tmpBuf + 4) == 0x7265)
    return 4; // "header"
  return 0;
}

function escChar(e: u8): u8 {
  if (e == 0x22) return 0x22;
  if (e == 0x5c) return 0x5c;
  if (e == 0x2f) return 0x2f;
  if (e == 0x62) return 0x08;
  if (e == 0x66) return 0x0c;
  if (e == 0x6e) return 0x0a;
  if (e == 0x72) return 0x0d;
  if (e == 0x74) return 0x09;
  return e;
}

// Encode cp as UTF-8 at ptr; a lone surrogate becomes WTF-8 (ED A0..BF).
// Returns the byte count. (Only used for JSON keys, which are ASCII here,
// but kept for correctness.)
function utf8Encode(ptr: usize, cp: i32): i32 {
  if (cp < 0x80) {
    store<u8>(ptr, <u8>cp);
    return 1;
  }
  if (cp < 0x800) {
    store<u8>(ptr, <u8>(0xc0 | (cp >> 6)));
    store<u8>(ptr + 1, <u8>(0x80 | (cp & 0x3f)));
    return 2;
  }
  if (cp < 0x10000) {
    store<u8>(ptr, <u8>(0xe0 | (cp >> 12)));
    store<u8>(ptr + 1, <u8>(0x80 | ((cp >> 6) & 0x3f)));
    store<u8>(ptr + 2, <u8>(0x80 | (cp & 0x3f)));
    return 3;
  }
  store<u8>(ptr, <u8>(0xf0 | (cp >> 18)));
  store<u8>(ptr + 1, <u8>(0x80 | ((cp >> 12) & 0x3f)));
  store<u8>(ptr + 2, <u8>(0x80 | ((cp >> 6) & 0x3f)));
  store<u8>(ptr + 3, <u8>(0x80 | (cp & 0x3f)));
  return 4;
}

// Locate the raw span of the JSON string at jp (do NOT unescape it):
// sets caseTextStart (after the opening quote) and caseTextEnd (at the
// closing quote). jp points at the opening quote.
function jFindText(): void {
  jp++;
  caseTextStart = jp;
  for (;;) {
    const hit = find2(0x22, 0x5c, jp, jEnd);
    if (hit >= jEnd) {
      failed = true;
      debug = 6;
      return;
    }
    if (load<u8>(hit) == 0x22) {
      caseTextEnd = hit;
      jp = hit + 1;
      return;
    }
    if (load<u8>(hit + 1) == 0x75) jp = hit + 6;
    else jp = hit + 2;
  }
}

function jParseInputObject(): void {
  jp++;
  jSkipWs();
  if (load<u8>(jp) == 0x7d) {
    jp++;
    return;
  }
  for (;;) {
    jSkipWs();
    const k = jReadKey();
    if (failed) return;
    jSkipWs();
    if (load<u8>(jp) != 0x3a) {
      failed = true;
      debug = 7;
      return;
    }
    jp++;
    if (k == 3) jFindText();
    else if (k == 4) {
      jSkipWs();
      caseHeader = load<u8>(jp) == 0x74;
      jp += caseHeader ? 4 : 5;
    } else jSkipValue();
    if (failed) return;
    jSkipWs();
    const c = load<u8>(jp);
    if (c == 0x2c) {
      jp++;
      continue;
    }
    if (c == 0x7d) {
      jp++;
      return;
    }
    failed = true;
    debug = 7;
    return;
  }
}

function jParseCaseObject(): void {
  jp++;
  jSkipWs();
  if (load<u8>(jp) == 0x7d) {
    jp++;
    return;
  }
  for (;;) {
    jSkipWs();
    const k = jReadKey();
    if (failed) return;
    jSkipWs();
    if (load<u8>(jp) != 0x3a) {
      failed = true;
      debug = 10;
      return;
    }
    jp++;
    if (k == 2) jParseInputObject();
    else jSkipValue();
    if (failed) return;
    jSkipWs();
    const c = load<u8>(jp);
    if (c == 0x2c) {
      jp++;
      continue;
    }
    if (c == 0x7d) {
      jp++;
      return;
    }
    failed = true;
    debug = 10;
    return;
  }
}

// ---------- errors ----------

function errOpen(code: string): void {
  if (errCount > 0) errByte(0x2c);
  errCount++;
  errLit('{"code":"');
  errLit(code);
  errLit('","line":');
  errInt(recordLine);
  errLit(',"row":');
  if (recordRow < 0) errLit('null');
  else errInt(recordRow);
}

function pushStrayCr(): void {
  errOpen('stray_cr');
  errByte(0x7d);
}

function pushUnterminated(): void {
  errOpen('unterminated_quote');
  errByte(0x7d);
}

function pushQuoteJunk(): void {
  errOpen('quote_junk');
  errByte(0x7d);
}

function pushShortRow(nfields: i32): void {
  errOpen('short_row');
  errLit(',"fields":');
  errInt(nfields);
  errByte(0x7d);
}

function pushLongRow(): void {
  errOpen('long_row');
  errLit(',"extra":[');
  // Descriptors hold this record's extra fields as scratch ranges; the
  // scratch already holds their correctly JSON-escaped string bodies.
  for (let i = 0; i < descCount; i++) {
    if (i > 0) errByte(0x2c);
    errByte(0x22);
    errCopy(descStart(i), descEnd(i) - descStart(i));
    errByte(0x22);
  }
  errLit(']}');
}

// ---------- field descriptors (long-row extras only) ----------

// Descriptor: 16 bytes: start, end (scratch range of the decoded JSON
// string body), kind, flags (unused).
function addDesc(start: usize, end: usize, kind: i32, flags: i32): void {
  if (descCount >= DESC_CAP) {
    failed = true;
    debug = 11;
    return;
  }
  const d = descBuf + <usize>descCount * 16;
  store<u32>(d, <u32>start);
  store<u32>(d + 4, <u32>end);
  store<u32>(d + 8, kind);
  store<u32>(d + 12, flags);
  descCount++;
}

function descStart(i: i32): usize {
  return <usize>load<u32>(descBuf + <usize>i * 16);
}

function descEnd(i: i32): usize {
  return <usize>load<u32>(descBuf + <usize>i * 16 + 4);
}

// ---------- decoded-char peek ----------

// Kind of the decoded char at raw position p; sets peekLen to the raw
// token length (1 for a raw byte, 2 for a short escape, 6 for \uXXXX).
// A raw byte that is not ',' or '\' is content (a raw '"' or control
// byte cannot occur inside a JSON string span).
function peekKind(p: usize): i32 {
  if (p >= tEnd) return PK_END;
  const b = load<u8>(p);
  if (b == 0x2c) {
    peekLen = 1;
    return PK_COMMA;
  }
  if (b == 0x5c) {
    if (p + 1 >= tEnd) {
      peekLen = 1;
      return PK_CONTENT;
    }
    const e = load<u8>(p + 1);
    if (e == 0x6e) {
      peekLen = 2;
      return PK_LF;
    }
    if (e == 0x72) {
      peekLen = 2;
      return PK_CR;
    }
    if (e == 0x22) {
      peekLen = 2;
      return PK_QUOTE;
    }
    if (e == 0x75) {
      const cp = hex4(p + 2);
      peekLen = 6;
      if (cp == 0x2c) return PK_COMMA;
      if (cp == 0x0a) return PK_LF;
      if (cp == 0x0d) return PK_CR;
      if (cp == 0x22) return PK_QUOTE;
      return PK_CONTENT;
    }
    peekLen = 2;
    return PK_CONTENT;
  }
  peekLen = 1;
  return PK_CONTENT;
}

// ---------- CSV field readers (raw span, single pass) ----------

// Destination write position right after the current field's opening
// '"' (in the output, or in the scratch for an extra field). The
// unterminated-quote fallback retracts to it.
let dstContentStart: usize = 0;

// Read an unquoted field starting at tp. Content is emitted via wCopy /
// wByte to the current destination (output or extra scratch). Sets
// fEnded (0=COMMA, 1=LINE_BREAK, 2=END) and addedAny (whether any
// content character was kept).
function readUnquotedRaw(): void {
  addedAny = false;
  for (;;) {
    const hit = find2(0x2c, 0x5c, tp, tEnd);
    if (hit >= tEnd) {
      if (hit > tp) {
        wCopy(tp, hit - tp);
        addedAny = true;
      }
      tp = tEnd;
      fEnded = 2;
      return;
    }
    const d = load<u8>(hit);
    if (d == 0x2c) {
      if (hit > tp) {
        wCopy(tp, hit - tp);
        addedAny = true;
      }
      tp = hit + 1;
      fEnded = 0;
      return;
    }
    // d == 0x5c: an escape.
    if (hit > tp) {
      wCopy(tp, hit - tp);
      addedAny = true;
    }
    const e = load<u8>(hit + 1);
    if (e == 0x6e) {
      // \n: LF -> record end.
      tp = hit + 2;
      line++;
      fEnded = 1;
      return;
    }
    if (e == 0x72) {
      // \r: CRLF -> record end; lone CR -> drop + stray_cr.
      const k = peekKind(hit + 2);
      if (k == PK_LF) {
        tp = hit + 2 + peekLen;
        line++;
        fEnded = 1;
        return;
      }
      pushStrayCr();
      tp = hit + 2;
      continue;
    }
    if (e == 0x75) {
      const cp = hex4(hit + 2);
      if (cp == 0x2c) {
        tp = hit + 6;
        fEnded = 0;
        return;
      }
      if (cp == 0x0a) {
        tp = hit + 6;
        line++;
        fEnded = 1;
        return;
      }
      if (cp == 0x0d) {
        const k = peekKind(hit + 6);
        if (k == PK_LF) {
          tp = hit + 6 + peekLen;
          line++;
          fEnded = 1;
          return;
        }
        pushStrayCr();
        tp = hit + 6;
        continue;
      }
      // Not special (including quote): content, copy the 6 bytes verbatim.
      wCopy(hit, 6);
      addedAny = true;
      tp = hit + 6;
      continue;
    }
    // Other escapes (\", \\, \/, \b, \f, \t): a quote is a literal
    // character in an unquoted field; the rest are content. Copy verbatim.
    wCopy(hit, 2);
    addedAny = true;
    tp = hit + 2;
  }
}

// Read a quoted field whose opening '\"' starts at tp. Content is
// emitted to the current destination. Sets fEnded. On an unterminated
// quote, retracts the destination to the field's content start, pushes
// the error, resets the line, emits a literal quote and re-reads the
// rest as unquoted (exactly as csv-reader 1.0.0 does).
function readQuotedRaw(): void {
  const open = tp;
  const openLine = line;
  const contentStart = tp + 2;
  tp = contentStart;
  for (;;) {
    const hit = find1(0x5c, tp, tEnd);
    if (hit >= tEnd) {
      // Unterminated: the quote never closes before the text ends.
      if (toScratch) scratchPtr = dstContentStart;
      else outPtr = dstContentStart;
      pushUnterminated();
      line = openLine;
      wByte(0x5c);
      wByte(0x22);
      addedAny = true;
      tp = contentStart;
      readUnquotedRaw();
      return;
    }
    if (hit > tp) {
      wCopy(tp, hit - tp);
      addedAny = true;
    }
    const e = load<u8>(hit + 1);
    if (e == 0x22) {
      // A quote: doubled or closing?
      const k = peekKind(hit + 2);
      if (k == PK_QUOTE) {
        // Doubled: emit one '\"', consume both quote tokens.
        wCopy(hit, 2);
        addedAny = true;
        tp = hit + 2 + peekLen;
        continue;
      }
      // Closing quote.
      tp = hit + 2;
      break;
    }
    if (e == 0x6e) {
      // LF inside quotes: content, copy verbatim.
      wCopy(hit, 2);
      addedAny = true;
      line++;
      tp = hit + 2;
      continue;
    }
    if (e == 0x72) {
      // CR inside quotes: read as LF, emit '\n' (not the raw '\r').
      wByte(0x5c);
      wByte(0x6e);
      addedAny = true;
      line++;
      const k = peekKind(hit + 2);
      if (k == PK_LF) tp = hit + 2 + peekLen;
      else tp = hit + 2;
      continue;
    }
    if (e == 0x75) {
      const cp = hex4(hit + 2);
      if (cp == 0x22) {
        const k = peekKind(hit + 6);
        if (k == PK_QUOTE) {
          // Doubled (as \u0022): emit one '\"', consume both.
          wByte(0x5c);
          wByte(0x22);
          addedAny = true;
          tp = hit + 6 + peekLen;
          continue;
        }
        // Closing quote (as \u0022).
        tp = hit + 6;
        break;
      }
      if (cp == 0x0a) {
        // LF inside quotes: content, copy the 6 bytes verbatim.
        wCopy(hit, 6);
        addedAny = true;
        line++;
        tp = hit + 6;
        continue;
      }
      if (cp == 0x0d) {
        // CR inside quotes: read as LF, emit '\n'.
        wByte(0x5c);
        wByte(0x6e);
        addedAny = true;
        line++;
        const k = peekKind(hit + 6);
        if (k == PK_LF) tp = hit + 6 + peekLen;
        else tp = hit + 6;
        continue;
      }
      // Not special (including comma): content, copy the 6 bytes verbatim.
      wCopy(hit, 6);
      addedAny = true;
      tp = hit + 6;
      continue;
    }
    // Other escapes (\\, \/, \b, \f, \t): content, copy verbatim.
    wCopy(hit, 2);
    addedAny = true;
    tp = hit + 2;
  }
  // Closed: what follows the closing quote?
  if (tp >= tEnd) {
    fEnded = 2;
    return;
  }
  const k = peekKind(tp);
  if (k == PK_COMMA) {
    tp += peekLen;
    fEnded = 0;
    return;
  }
  if (k == PK_LF) {
    tp += peekLen;
    line++;
    fEnded = 1;
    return;
  }
  if (k == PK_CR) {
    const len1 = peekLen;
    const k2 = peekKind(tp + len1);
    if (k2 == PK_LF) {
      tp += len1 + peekLen;
      line++;
      fEnded = 1;
      return;
    }
    // Lone CR after the closing quote: it starts the junk (read as
    // unquoted below; the junk reader drops it with stray_cr).
  }
  // Junk after the closing quote: read unquoted, appending to the value.
  readUnquotedRaw();
  if (addedAny) pushQuoteJunk();
  // fEnded is set by readUnquotedRaw.
}

// ---------- record / case ----------

// Parse one record, emitting each field to the output as it is read
// (fused parse+emit). Row fields go straight out; fields past the width
// (long row) go to the scratch buffer, kept as descriptors for the
// error's extra array, which pushLongRow emits after the record ends
// (so error order is preserved).
function parseRecord(): void {
  descCount = 0;
  scratchPtr = scratchBuf;
  recordLine = line;
  recordRow = headerFlag && !columnsDone ? -1 : rowsEmitted;
  fieldCount = 0;
  firstFieldEmpty = true;
  for (;;) {
    const isExtra = !recFirst && fieldCount >= width;
    const kind = peekKind(tp);
    lastQuoted = kind == PK_QUOTE;
    if (isExtra) {
      toScratch = true;
      wByte(0x22);
      dstContentStart = scratchPtr;
      if (lastQuoted) readQuotedRaw();
      else readUnquotedRaw();
      const contentEnd = scratchPtr;
      wByte(0x22);
      addDesc(dstContentStart, contentEnd, 0, 0);
      toScratch = false;
    } else {
      if (fieldCount > 0) outByte(0x2c);
      wByte(0x22);
      dstContentStart = outPtr;
      if (lastQuoted) readQuotedRaw();
      else readUnquotedRaw();
      if (fieldCount == 0) firstFieldEmpty = outPtr == dstContentStart;
      wByte(0x22);
    }
    fieldCount++;
    if (fEnded != 0) break;
  }
}

function processCase(ts: usize, te: usize, header: bool): void {
  tEnd = te;
  tp = ts;
  // BOM: drop U+FEFF at the very start (raw UTF-8 EF BB BF, or a
  // \ufeff / \uFEFF escape).
  if (te - ts >= 3 && load<u8>(ts) == 0xef && load<u8>(ts + 1) == 0xbb && load<u8>(ts + 2) == 0xbf) {
    tp = ts + 3;
  } else if (te - ts >= 6 && load<u8>(ts) == 0x5c && load<u8>(ts + 1) == 0x75 && hex4(ts + 2) == 0xfeff) {
    tp = ts + 6;
  }
  line = 1;
  width = -1;
  rowsEmitted = 0;
  columnsDone = false;
  headerFlag = header;
  errPtr = errBuf;
  errCount = 0;

  outLit('{"columns":');
  let first = true;
  for (;;) {
    // Skip blank lines: a line break (LF or CRLF) with no characters.
    while (tp < tEnd) {
      const k = peekKind(tp);
      const len1 = peekLen;
      if (k == PK_LF) {
        tp += len1;
        line++;
        continue;
      }
      if (k == PK_CR) {
        const k2 = peekKind(tp + len1);
        if (k2 == PK_LF) {
          tp += len1 + peekLen;
          line++;
          continue;
        }
      }
      break;
    }
    if (tp >= tEnd) break;
    // Rollback point: a record that turns out to be an empty line must
    // vanish from the output (its opening bracket and field).
    const savedOut = outPtr;
    if (first) {
      if (header) outByte(0x5b);
      else outLit('null,"rows":[[');
    } else {
      if (rowsEmitted > 0) outByte(0x2c);
      outByte(0x5b);
    }
    recFirst = first;
    parseRecord();
    if (failed) return;
    if (fieldCount == 1 && !lastQuoted && firstFieldEmpty) {
      // Empty line: retract only its output (opening bracket and field).
      // Its errors (e.g. a trailing lone CR's stray_cr) are kept: the
      // reference includes them.
      outPtr = savedOut;
      continue;
    }
    if (first) {
      first = false;
      width = fieldCount;
      if (header) {
        outLit('],"rows":[');
        columnsDone = true;
      } else {
        outByte(0x5d);
        rowsEmitted = 1;
      }
    } else {
      if (fieldCount < width) {
        pushShortRow(fieldCount);
        for (let i = fieldCount; i < width; i++) outLit(',""');
      } else if (fieldCount > width) {
        pushLongRow();
      }
      if (failed) return;
      outByte(0x5d);
      rowsEmitted++;
    }
    if (failed) return;
  }
  if (first) {
    outLit(header ? '[]' : 'null');
    outLit(',"rows":[]');
  } else {
    outByte(0x5d);
  }
  outLit(',"errors":[');
  outCopy(errBuf, errPtr - errBuf);
  outLit(']}');
}

// ---------- top level ----------

export function process(): i32 {
  jp = inBuf;
  jEnd = inBuf + <usize>inLen;
  outPtr = outBuf;
  outCap = (memory.size() as usize) << 16;
  failed = false;
  debug = 0;
  toScratch = false;

  jSkipWs();
  if (jp >= jEnd || load<u8>(jp) != 0x5b) {
    debug = 12;
    return -1;
  }
  jp++;
  outByte(0x5b);
  let firstCase = true;
  for (;;) {
    jSkipWs();
    if (jp >= jEnd) {
      debug = 13;
      return -1;
    }
    const b = load<u8>(jp);
    if (b == 0x5d) {
      jp++;
      break;
    }
    if (b == 0x2c) {
      jp++;
      continue;
    }
    if (b != 0x7b) {
      debug = 14;
      return -1;
    }
    caseTextStart = 0;
    caseTextEnd = 0;
    caseHeader = false;
    jParseCaseObject();
    if (failed) return -1;
    if (!firstCase) outByte(0x2c);
    firstCase = false;
    processCase(caseTextStart, caseTextEnd, caseHeader);
    if (failed) return -1;
  }
  outByte(0x5d);
  if (failed) return -1;
  return <i32>(outPtr - outBuf);
}
