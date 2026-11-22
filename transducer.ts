// Byte-level JSON-to-JSON CSV transducer for csv-reader 1.0.0.
//
// The entry's main.ts reads /input/cases.json as raw bytes, hands them to
// process() here, and writes the returned output bytes to
// /output/answers.json. Nothing is JSON.parsed or JSON.stringified: the
// JSON is scanned at the byte level, each case's text is unescaped into a
// buffer, the CSV state machine (a faithful port of csv-reader 1.0.0)
// runs on those bytes, and the answer JSON is emitted directly.
//
// Memory (all bump-allocated from the stub heap in setup()):
//   inBuf      input bytes [0, N)
//   textBuf    unescaped CSV text (append-only, one case at a time)
//   scratchBuf per-record transformed field values
//   descBuf    field descriptors, 12 bytes each (start, end, kind)
//   errBuf     the current case's errors JSON fragments
//   tmpBuf     64 bytes: JSON key buffer + itoa temp
//   outBuf     output; extends to the end of memory, grown as needed
//
// A field value is either a verbatim range of the text buffer (kind 0) or
// a transformed copy in the scratch buffer (kind 1). Lone surrogates in
// the input arrive as \uXXXX escapes and are kept internally as WTF-8
// (ED A0..BF); the emitter turns those back into \uXXXX, exactly as
// JSON.stringify does.

// ---------- buffers ----------
let inBuf: usize = 0;
let textBuf: usize = 0;
let scratchBuf: usize = 0;
let descBuf: usize = 0;
let errBuf: usize = 0;
let tmpBuf: usize = 0;
let outBuf: usize = 0;
let inLen: i32 = 0;
let textW: usize = 0;
let outPtr: usize = 0;
let outCap: usize = 0;
let errPtr: usize = 0;
let errCount: i32 = 0;
let scratchPtr: usize = 0;
let failed: bool = false;
let debug: i32 = 0;

// ---------- JSON scanner ----------
let jp: usize = 0;
let jEnd: usize = 0;
let caseTextStart: usize = 0;
let caseTextEnd: usize = 0;
let caseHeader: bool = false;

// ---------- CSV parser ----------
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

// ---------- field result ----------
let fStart: usize = 0;
let fEnd: usize = 0;
let fKind: i32 = 0;
let fEnded: i32 = 0; // 0=COMMA, 1=LINE_BREAK, 2=END
let fAdded: i32 = 0;
let fNeedsEscape: bool = false;

const DESC_BYTES: usize = 4 * 1024 * 1024;
const DESC_CAP: i32 = 262144; // 4 MiB / 16 bytes per descriptor
const ERR_BYTES: usize = 12 * 1024 * 1024;

// ---------- setup / exports ----------

export function setup(inputLen: i32): usize {
  inLen = inputLen;
  const n = <usize>inputLen;
  inBuf = heap.alloc(n);
  textBuf = heap.alloc(n);
  scratchBuf = heap.alloc(n);
  descBuf = heap.alloc(DESC_BYTES);
  errBuf = heap.alloc(ERR_BYTES);
  tmpBuf = heap.alloc(64);
  outBuf = heap.alloc(16);
  textW = textBuf;
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

function find3(b1: u8, b2: u8, b3: u8, from: usize, to: usize): usize {
  const v1 = i8x16.splat(b1);
  const v2 = i8x16.splat(b2);
  const v3 = i8x16.splat(b3);
  let p = from;
  while (p < to) {
    const rem = to - p;
    if (rem >= 16) {
      const v = v128.load(p);
      const m = i8x16.bitmask(
        v128.or(v128.or(i8x16.eq(v, v1), i8x16.eq(v, v2)), i8x16.eq(v, v3))
      );
      if (m != 0) return p + <usize>i32.ctz(m);
      p += 16;
    } else {
      const v = v128.load(p);
      const m =
        i8x16.bitmask(v128.or(v128.or(i8x16.eq(v, v1), i8x16.eq(v, v2)), i8x16.eq(v, v3))) &
        ((1 << <i32>rem) - 1);
      if (m != 0) return p + <usize>i32.ctz(m);
      return to;
    }
  }
  return to;
}

// Next byte that ends an unquoted field (',', LF, CR) or that needs JSON
// escaping ('"', '\\', 0xed, or any other byte < 0x20).
function findUnq(from: usize, to: usize): usize {
  const v20 = i8x16.splat(0x20);
  const v22 = i8x16.splat(0x22);
  const v2c = i8x16.splat(0x2c);
  const v5c = i8x16.splat(0x5c);
  const vEd = i8x16.splat(-19); // 0xed
  let p = from;
  while (p < to) {
    const rem = to - p;
    const v = v128.load(p);
    const m = i8x16.bitmask(
      v128.or(
        v128.or(
          v128.or(i8x16.lt_u(v, v20), i8x16.eq(v, v22)),
          v128.or(i8x16.eq(v, v2c), i8x16.eq(v, v5c))
        ),
        i8x16.eq(v, vEd)
      )
    );
    if (rem >= 16) {
      if (m != 0) return p + <usize>i32.ctz(m);
      p += 16;
    } else {
      const mm = m & ((1 << <i32>rem) - 1);
      if (mm != 0) return p + <usize>i32.ctz(mm);
      return to;
    }
  }
  return to;
}

// First byte that needs JSON escaping: < 0x20, '"' (0x22), '\\' (0x5c),
// or 0xed (possible WTF-8 lone-surrogate lead byte).
function findEscape(from: usize, to: usize): usize {
  const v20 = i8x16.splat(0x20);
  const v22 = i8x16.splat(0x22);
  const v5c = i8x16.splat(0x5c);
  const vEd = i8x16.splat(-19); // 0xed
  let p = from;
  while (p < to) {
    const rem = to - p;
    const v = v128.load(p);
    const m = i8x16.bitmask(
      v128.or(
        v128.or(i8x16.lt_u(v, v20), i8x16.eq(v, v22)),
        v128.or(i8x16.eq(v, v5c), i8x16.eq(v, vEd))
      )
    );
    if (rem >= 16) {
      if (m != 0) return p + <usize>i32.ctz(m);
      p += 16;
    } else {
      const mm = m & ((1 << <i32>rem) - 1);
      if (mm != 0) return p + <usize>i32.ctz(mm);
      return to;
    }
  }
  return to;
}

// ---------- output / errors append ----------

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

function outByte(b: u8): void {
  if (failed) return;
  if (outPtr >= outCap) growOut(1);
  if (failed) return;
  store<u8>(outPtr, b);
  outPtr++;
}

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

function outCopy(src: usize, len: usize): void {
  if (failed || len == 0) return;
  if (outPtr + len > outCap) growOut(len);
  if (failed) return;
  if (len < 32) copySmall(outPtr, src, len);
  else memory.copy(outPtr, src, len);
  outPtr += len;
}

function outLit(s: string): void {
  for (let i = 0; i < s.length; i++) outByte(<u8>s.charCodeAt(i));
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

// ---------- hex / utf-8 ----------

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

// Encode cp as UTF-8 at ptr; a lone surrogate becomes WTF-8 (ED A0..BF),
// the standard 3-byte UTF-8 encoding of the surrogate value itself.
// Returns the byte count.
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

// Unescape the JSON string at jp into the text buffer; sets
// caseTextStart/caseTextEnd. jp points at the opening quote.
function jReadText(): void {
  jp++;
  caseTextStart = textW;
  for (;;) {
    const hit = find2(0x22, 0x5c, jp, jEnd);
    if (hit >= jEnd) {
      failed = true;
      debug = 6;
      return;
    }
    const n = hit - jp;
    if (n > 0) {
      if (n < 32) copySmall(textW, jp, n);
      else memory.copy(textW, jp, n);
      textW += n;
    }
    if (load<u8>(hit) == 0x22) {
      jp = hit + 1;
      break;
    }
    const e = load<u8>(hit + 1);
    if (e == 0x75) {
      const cp = hex4(hit + 2);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        if (
          load<u8>(hit + 6) == 0x5c &&
          load<u8>(hit + 7) == 0x75
        ) {
          const cp2 = hex4(hit + 8);
          if (cp2 >= 0xdc00 && cp2 <= 0xdfff) {
            const full = 0x10000 + ((cp - 0xd800) << 10) + (cp2 - 0xdc00);
            textW += <usize>utf8Encode(textW, full);
            jp = hit + 12;
            continue;
          }
        }
        textW += <usize>utf8Encode(textW, cp);
        jp = hit + 6;
      } else {
        textW += <usize>utf8Encode(textW, cp);
        jp = hit + 6;
      }
    } else {
      store<u8>(textW, escChar(e));
      textW++;
      jp = hit + 2;
    }
  }
  caseTextEnd = textW;
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
    if (k == 3) jReadText();
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

// ---------- escaped emission (output or errors buffer) ----------

function put1(toErr: bool, b: u8): void {
  if (toErr) errByte(b);
  else outByte(b);
}

function putHexDigit(toErr: bool, n: i32): void {
  put1(toErr, <u8>(n < 10 ? 0x30 + n : 0x61 + n - 10));
}

function putHex4(toErr: bool, cp: i32): void {
  putHexDigit(toErr, (cp >> 12) & 0xf);
  putHexDigit(toErr, (cp >> 8) & 0xf);
  putHexDigit(toErr, (cp >> 4) & 0xf);
  putHexDigit(toErr, cp & 0xf);
}

function putHex2(toErr: bool, b: i32): void {
  putHexDigit(toErr, (b >> 4) & 0xf);
  putHexDigit(toErr, b & 0xf);
}

// Copy [s, e) with JSON.stringify-identical escaping.
function emitEscapedTo(s: usize, e: usize, toErr: bool): void {
  let p = s;
  while (p < e) {
    const hit = findEscape(p, e);
    if (hit > p) {
      if (toErr) errCopy(p, hit - p);
      else outCopy(p, hit - p);
    }
    if (hit >= e) break;
    const b = load<u8>(hit);
    if (b == 0x22) {
      put1(toErr, 0x5c);
      put1(toErr, 0x22);
      p = hit + 1;
    } else if (b == 0x5c) {
      put1(toErr, 0x5c);
      put1(toErr, 0x5c);
      p = hit + 1;
    } else if (b == 0x0a) {
      put1(toErr, 0x5c);
      put1(toErr, 0x6e);
      p = hit + 1;
    } else if (b == 0x0d) {
      put1(toErr, 0x5c);
      put1(toErr, 0x72);
      p = hit + 1;
    } else if (b == 0x09) {
      put1(toErr, 0x5c);
      put1(toErr, 0x74);
      p = hit + 1;
    } else if (b == 0x08) {
      put1(toErr, 0x5c);
      put1(toErr, 0x62);
      p = hit + 1;
    } else if (b == 0x0c) {
      put1(toErr, 0x5c);
      put1(toErr, 0x66);
      p = hit + 1;
    } else if (b == 0xed) {
      if (hit + 2 < e) {
        const b2: i32 = load<u8>(hit + 1);
        const b3: i32 = load<u8>(hit + 2);
        if (b2 >= 0xa0 && b2 <= 0xbf && (b3 & 0xc0) == 0x80) {
          const cp = 0xd000 | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
          put1(toErr, 0x5c);
          put1(toErr, 0x75);
          putHex4(toErr, cp);
          p = hit + 3;
          continue;
        }
      }
      put1(toErr, 0xed);
      p = hit + 1;
    } else {
      put1(toErr, 0x5c);
      put1(toErr, 0x75);
      put1(toErr, 0x30);
      put1(toErr, 0x30);
      putHex2(toErr, b);
      p = hit + 1;
    }
    if (failed) return;
  }
}

// ---------- field descriptors ----------

// Descriptor: 16 bytes: start, end, kind (0=text range, 1=scratch), flags
// (bit 0 = the value needs JSON escaping).
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

function descLen(i: i32): i32 {
  const d = descBuf + <usize>i * 16;
  return <i32>(load<u32>(d + 4) - load<u32>(d));
}

function descStart(i: i32): usize {
  return <usize>load<u32>(descBuf + <usize>i * 16);
}

function descEnd(i: i32): usize {
  return <usize>load<u32>(descBuf + <usize>i * 16 + 4);
}

function descFlags(i: i32): i32 {
  return load<u32>(descBuf + <usize>i * 16 + 12);
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
  for (let i = width; i < fieldCount; i++) {
    if (i > width) errByte(0x2c);
    errByte(0x22);
    emitEscapedTo(descStart(i), descEnd(i), true);
    errByte(0x22);
  }
  errLit(']}');
}

// ---------- CSV field readers (port of csv-reader 1.0.0) ----------

// Copy [start, end) minus CR bytes into the scratch buffer.
function copyMinusCR(start: usize, end: usize): usize {
  let w = scratchPtr;
  let p = start;
  while (p < end) {
    const b = load<u8>(p);
    if (b != 0x0d) {
      store<u8>(w, b);
      w++;
    }
    p++;
  }
  return w;
}

function finishUnquoted(start: usize, end: usize, stray: bool, kept: i32, ended: i32): void {
  if (!stray) {
    fStart = start;
    fEnd = end;
    fKind = 0;
  } else {
    const w = copyMinusCR(start, end);
    fStart = scratchPtr;
    fEnd = w;
    fKind = 1;
    scratchPtr = w;
  }
  fEnded = ended;
  fAdded = kept;
}

function readUnquoted(): void {
  const start = tp;
  let stray = false;
  let strayCount: i32 = 0;
  fNeedsEscape = false;
  for (;;) {
    const hit = findUnq(tp, tEnd);
    if (hit >= tEnd) {
      tp = tEnd;
      finishUnquoted(start, tEnd, stray, <i32>(tEnd - start) - strayCount, 2);
      return;
    }
    const d = load<u8>(hit);
    if (d == 0x2c) {
      tp = hit + 1;
      finishUnquoted(start, hit, stray, <i32>(hit - start) - strayCount, 0);
      return;
    }
    if (d == 0x0a) {
      tp = hit + 1;
      line++;
      finishUnquoted(start, hit, stray, <i32>(hit - start) - strayCount, 1);
      return;
    }
    if (d == 0x0d) {
      if (hit + 1 < tEnd && load<u8>(hit + 1) == 0x0a) {
        tp = hit + 2;
        line++;
        finishUnquoted(start, hit, stray, <i32>(hit - start) - strayCount, 1);
        return;
      }
      pushStrayCr();
      stray = true;
      strayCount++;
      tp = hit + 1;
      continue;
    }
    // '"' (0x22), '\\' (0x5c), 0xed, or another control byte: content
    // that needs JSON escaping.
    fNeedsEscape = true;
    tp = hit + 1;
  }
}

// Copy quoted content [a, b) to scratch: "" -> ", CR / CRLF -> LF.
function transformQuoted(a: usize, b: usize): void {
  let w = scratchPtr;
  let p = a;
  while (p < b) {
    const c = load<u8>(p);
    if (c == 0x22) {
      store<u8>(w, 0x22);
      w++;
      p += 2;
    } else if (c == 0x0d) {
      store<u8>(w, 0x0a);
      w++;
      if (p + 1 < b && load<u8>(p + 1) == 0x0a) p += 2;
      else p += 1;
    } else {
      store<u8>(w, c);
      w++;
      p++;
    }
  }
  fStart = scratchPtr;
  fEnd = w;
  fKind = 1;
  scratchPtr = w;
}

function readQuoted(): void {
  const open = tp;
  const openLine = line;
  tp++;
  const contentStart = tp;
  let hasDouble = false;
  let hasCR = false;
  let skipLF = false;
  fNeedsEscape = false;
  for (;;) {
    // One scan finds the next quote, CR, LF, backslash, 0xed, or other
    // control byte: quotes end or double the field, CR/LF count lines
    // (a CRLF counts once) and mark the value for escaping, the rest
    // only mark it.
    const hit = findEscape(tp, tEnd);
    if (hit >= tEnd) {
      tp = open + 1;
      line = openLine;
      pushUnterminated();
      readUnquoted();
      if (failed) return;
      // The field value is '"' + the re-read value.
      store<u8>(scratchPtr, 0x22);
      memory.copy(scratchPtr + 1, fStart, fEnd - fStart);
      const ns = scratchPtr;
      const ne = scratchPtr + 1 + (fEnd - fStart);
      fStart = ns;
      fEnd = ne;
      fKind = 1;
      fNeedsEscape = true;
      scratchPtr = ne;
      return;
    }
    const b = load<u8>(hit);
    if (b == 0x22) {
      if (hit + 1 < tEnd && load<u8>(hit + 1) == 0x22) {
        hasDouble = true;
        fNeedsEscape = true;
        tp = hit + 2;
        continue;
      }
      tp = hit + 1;
      if (!hasDouble && !hasCR) {
        fStart = contentStart;
        fEnd = hit;
        fKind = 0;
      } else {
        transformQuoted(contentStart, hit);
      }
      if (hasDouble || hasCR) fNeedsEscape = true;
      if (tp >= tEnd) {
        fEnded = 2;
        fAdded = 0;
        return;
      }
      const c = load<u8>(tp);
      if (c == 0x2c) {
        tp++;
        fEnded = 0;
        fAdded = 0;
        return;
      }
      if (c == 0x0a) {
        tp++;
        line++;
        fEnded = 1;
        fAdded = 0;
        return;
      }
      if (c == 0x0d && tp + 1 < tEnd && load<u8>(tp + 1) == 0x0a) {
        tp += 2;
        line++;
        fEnded = 1;
        fAdded = 0;
        return;
      }
      // Junk after the closing quote: read unquoted, appending to the value.
      const qStart = fStart;
      const qEnd = fEnd;
      const qKind = fKind;
      const qNeedsEscape = fNeedsEscape;
      readUnquoted();
      if (failed) return;
      if (fAdded > 0) {
        pushQuoteJunk();
        // Value = quoted content + junk bytes.
        memory.copy(scratchPtr, qStart, qEnd - qStart);
        let w = scratchPtr + (qEnd - qStart);
        memory.copy(w, fStart, fEnd - fStart);
        w += fEnd - fStart;
        fStart = scratchPtr;
        fEnd = w;
        fKind = 1;
        fNeedsEscape = qNeedsEscape || fNeedsEscape;
        scratchPtr = w;
      } else {
        fStart = qStart;
        fEnd = qEnd;
        fKind = qKind;
        fNeedsEscape = qNeedsEscape;
        fAdded = 0;
      }
      return;
    }
    if (b == 0x0d) {
      hasCR = true;
      fNeedsEscape = true;
      line++;
      if (hit + 1 < tEnd && load<u8>(hit + 1) == 0x0a) skipLF = true;
      tp = hit + 1;
      continue;
    }
    if (b == 0x0a) {
      if (skipLF) {
        skipLF = false;
        tp = hit + 1;
        continue;
      }
      fNeedsEscape = true;
      line++;
      tp = hit + 1;
      continue;
    }
    // '\\' (0x5c), 0xed, or another control byte: content needing escape.
    fNeedsEscape = true;
    tp = hit + 1;
  }
}

function parseRecord(): void {
  descCount = 0;
  scratchPtr = scratchBuf;
  recordLine = line;
  recordRow = headerFlag && !columnsDone ? -1 : rowsEmitted;
  fieldCount = 0;
  for (;;) {
    lastQuoted = load<u8>(tp) == 0x22;
    if (lastQuoted) readQuoted();
    else readUnquoted();
    if (failed) return;
    addDesc(fStart, fEnd, fKind, fNeedsEscape ? 1 : 0);
    if (failed) return;
    fieldCount++;
    if (fEnded != 0) break;
  }
}

// ---------- record emission ----------

function emitStringDesc(i: i32): void {
  const s = descStart(i);
  const e = descEnd(i);
  const len = e - s;
  if (descFlags(i) == 0) {
    // Plain copy with quotes, one bounds check, no per-byte calls.
    if (outPtr + len + 2 > outCap) growOut(len + 2);
    if (failed) return;
    store<u8>(outPtr, 0x22);
    if (len < 32) copySmall(outPtr + 1, s, len);
    else memory.copy(outPtr + 1, s, len);
    store<u8>(outPtr + 1 + len, 0x22);
    outPtr += len + 2;
  } else {
    outByte(0x22);
    emitEscapedTo(s, e, false);
    outByte(0x22);
  }
}

function emitFields(n: i32): void {
  outByte(0x5b);
  for (let i = 0; i < n; i++) {
    if (i > 0) outByte(0x2c);
    emitStringDesc(i);
  }
  outByte(0x5d);
}

function emitRow(): void {
  if (fieldCount < width) pushShortRow(fieldCount);
  else if (fieldCount > width) pushLongRow();
  if (failed) return;
  const n = fieldCount < width ? fieldCount : width;
  outByte(0x5b);
  for (let i = 0; i < n; i++) {
    if (i > 0) outByte(0x2c);
    emitStringDesc(i);
  }
  for (let i = n; i < width; i++) {
    outByte(0x2c);
    outByte(0x22);
    outByte(0x22);
  }
  outByte(0x5d);
}

function processCase(ts: usize, te: usize, header: bool): void {
  tEnd = te;
  tp = ts;
  if (te - ts >= 3 && load<u8>(ts) == 0xef && load<u8>(ts + 1) == 0xbb && load<u8>(ts + 2) == 0xbf)
    tp = ts + 3;
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
    while (tp < tEnd) {
      const c = load<u8>(tp);
      if (c == 0x0a) {
        tp++;
        line++;
      } else if (c == 0x0d && tp + 1 < tEnd && load<u8>(tp + 1) == 0x0a) {
        tp += 2;
        line++;
      } else break;
    }
    if (tp >= tEnd) break;
    parseRecord();
    if (failed) return;
    if (fieldCount == 1 && !lastQuoted && descLen(0) == 0) continue;
    if (first) {
      first = false;
      width = fieldCount;
      if (header) {
        emitFields(fieldCount);
        columnsDone = true;
      } else {
        outLit('null');
      }
      outLit(',"rows":[');
      if (!header) {
        emitRow();
        rowsEmitted = 1;
      }
    } else {
      if (rowsEmitted > 0) outByte(0x2c);
      emitRow();
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
  textW = textBuf;

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
    caseTextStart = textW;
    caseTextEnd = textW;
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
