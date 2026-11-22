// Fast drop-in for csv-reader 1.0.0 — v2.
//
// Same answers as the reference on every input: {columns, rows, errors}.
// v2 removes the costs v1 paid per field:
//   - no regex anywhere in the hot path: the line probe uses cached
//     indexOf scans (each delimiter class is swept once over the text in
//     C++), and unquoted fields scan with a tight charCodeAt loop;
//   - no object is allocated per field: the field readers report through
//     three shared slots (fval/fend/fadded) instead of a fresh object;
//   - quoted fields jump quote to quote with indexOf and build the value
//     by rope appends, so a field with one segment costs one slice;
//   - only multiline / doubled-quote segments go through a slow path.
// The per-field parser mirrors the reference rule for rule (stray_cr,
// quote_junk, unterminated_quote, short_row, long_row), so broken rows
// come out identical.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

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

  // Shared out-slots for the field readers: the field's value, how it
  // ended, and how many characters this read kept (for the quote_junk
  // rule). Reused, so no object is allocated per field.
  let fval = '';
  let fend = END;
  let fadded = 0;

  // Read an unquoted field starting at pos, with `value` already in it.
  // Sets fval, fend and fadded.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    for (;;) {
      let p = pos;
      while (p < n) {
        const ch = text.charCodeAt(p);
        if (ch === 44 || ch === 10 || ch === 13) break;
        p++;
      }
      if (p > start) {
        value += text.slice(start, p);
        added += p - start;
      }
      if (p >= n) {
        pos = n;
        fval = value;
        fend = END;
        fadded = added;
        return;
      }
      const d = text.charCodeAt(p);
      if (d === 44) {
        pos = p + 1;
        fval = value;
        fend = COMMA;
        fadded = added;
        return;
      }
      if (d === 10) {
        pos = p + 1;
        line += 1;
        fval = value;
        fend = LINE_BREAK;
        fadded = added;
        return;
      }
      if (text.charCodeAt(p + 1) === 10) {
        pos = p + 2;
        line += 1;
        fval = value;
        fend = LINE_BREAK;
        fadded = added;
        return;
      }
      // A CR not followed by LF is dropped, and the scan goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = p + 1;
      start = p + 1;
    }
  }

  // Read a quoted field whose opening quote is at pos. Sets fval, fend
  // and fadded (fadded counts only the junk after the closing quote).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (q > pos) {
        const seg = text.slice(pos, q);
        if (seg.indexOf('\n') !== -1 || seg.indexOf('\r') !== -1) {
          let breaks = 0;
          for (let i = 0; i < seg.length; i++) {
            const c = seg.charCodeAt(i);
            if (c === 10) breaks++;
            else if (c === 13) {
              breaks++;
              if (seg.charCodeAt(i + 1) === 10) i++;
            }
          }
          line += breaks;
          value += seg.replace(/\r\n?/g, '\n');
        } else {
          value += seg;
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      if (pos >= n) {
        fval = value;
        fend = END;
        fadded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fval = value;
        fend = COMMA;
        fadded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fval = value;
        fend = LINE_BREAK;
        fadded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fval = value;
        fend = LINE_BREAK;
        fadded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fadded > 0) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return;
    }
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

  // Next quote / CR at or after the position where the scan ran (n + 1
  // means none left). A scan's result stays valid until pos passes it,
  // so each delimiter class is swept once over the text.
  let nextQ = -1;
  let nextR = -1;

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

    // The line ends at the next LF. A quote on this line, or a CR that is
    // not the CRLF ending it, sends it to the careful path.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    if (nextQ < pos) {
      const q = text.indexOf('"', pos);
      nextQ = q === -1 ? n + 1 : q;
    }
    if (nextR < pos) {
      const r = text.indexOf('\r', pos);
      nextR = r === -1 ? n + 1 : r;
    }
    const hasQuote = nextQ < lineEnd;
    const hasStrayCR = nextR < lineEnd && !(nl !== -1 && nextR === nl - 1);

    if (!hasQuote && !hasStrayCR) {
      // Clean line: split it in one go, stripping a trailing CR (CRLF).
      const contentEnd = nl !== -1 && nextR === nl - 1 ? nl - 1 : lineEnd;
      if (contentEnd === pos) {
        pos = lineEnd === n ? n : lineEnd + 1;
        if (lineEnd !== n) line += 1;
        continue;
      }
      const fields = text.slice(pos, contentEnd).split(',');
      pos = lineEnd === n ? n : lineEnd + 1;
      if (lineEnd !== n) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // Careful path: at least one quote or stray CR on this line.
    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fval);
      if (fend !== COMMA) break;
    }
    finishRecord(fields, quoted);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}
