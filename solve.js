// Fast drop-in for csv-reader 1.0.0.
//
// Same answers as the reference on every input: {columns, rows, errors}.
// Speed comes from two choices the reference does not make:
//   - most records are read at line level: one regex scan finds the next
//     line break or quote, and a clean line is split in one go (slice +
//     split(',')), instead of walking it character by character;
//   - quoted fields jump from quote to quote with indexOf, and only the
//     rare multiline / doubled-quote segments go through a slow path.
// The careful per-field parser below the fast path mirrors the reference
// rule for rule (stray_cr, quote_junk, unterminated_quote, short_row,
// long_row), so broken rows come out identical.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// The next line break, quote or CR at or after `pos`.
const LINE_SCAN = /["\r\n]/g;
// The next comma, CR or LF at or after `pos`.
const DELIM = /[,\r\n]/g;

/** Count the line breaks in `s`: LF once, CRLF once, a lone CR once. */
function countBreaks(s) {
  const hits = s.match(/\r\n|\r|\n/g);
  return hits === null ? 0 : hits.length;
}

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null for the header). Helpers below read these as they stand.
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Read an unquoted field starting at pos, with `value` already in it.
  // Returns {value, ended, added}: ended is COMMA, LINE_BREAK or END, and
  // added counts the characters this call kept (not the ones in `value`).
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos);
          added += n - pos;
          pos = n;
        }
        return { value, ended: END, added };
      }
      const at = m.index;
      if (at > pos) {
        value += text.slice(pos, at);
        added += at - pos;
      }
      const d = m[0];
      if (d === ',') {
        pos = at + 1;
        return { value, ended: COMMA, added };
      }
      if (d === '\n') {
        pos = at + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (text.charCodeAt(at + 1) === 10) {
        pos = at + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR not followed by LF is dropped, and the scan goes on.
      pushError('stray_cr');
      pos = at + 1;
    }
  }

  // Read a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const parts = [];
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q > pos) {
        const seg = text.slice(pos, q);
        if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
          line += countBreaks(seg);
          parts.push(seg.replace(/\r\n?/g, '\n'));
        } else {
          parts.push(seg);
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        parts.push('"');
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      return readUnquoted('"');
    }
    const value = parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts.join('');
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) pushError('quote_junk');
    return junk;
  }

  // Finish a record's fields: header, width, padding or cutting, as the
  // reference does. A one-field empty unquoted record is no record.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < n) {
    // Lines with no characters are no records.
    const c = text.charCodeAt(pos);
    if (c === 10) {
      pos += 1;
      line += 1;
      continue;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      continue;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: one scan finds the next line break, quote or CR. A quote
    // or a lone CR on this line sends it to the careful path; a CRLF ends
    // the line with its CR stripped.
    LINE_SCAN.lastIndex = pos;
    const m = LINE_SCAN.exec(text);
    let end;
    let contentEnd;
    let hasQuote = false;
    if (m === null) {
      end = n;
      contentEnd = n;
    } else if (m[0] === '\n') {
      end = m.index;
      contentEnd = m.index;
    } else if (m[0] === '"') {
      hasQuote = true;
      end = -1;
      contentEnd = -1;
    } else if (text.charCodeAt(m.index + 1) === 10) {
      end = m.index + 1;
      contentEnd = m.index;
    } else {
      hasQuote = true;
      end = -1;
      contentEnd = -1;
    }
    if (!hasQuote) {
      if (contentEnd === pos) {
        pos = end === n ? n : end + 1;
        if (end !== n) line += 1;
        continue;
      }
      const fields = text.slice(pos, contentEnd).split(',');
      pos = end === n ? n : end + 1;
      if (end !== n) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // Careful path: at least one quote or stray CR on this line.
    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
      ended = field.ended;
    } while (ended === COMMA);
    finishRecord(fields, quoted);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}
