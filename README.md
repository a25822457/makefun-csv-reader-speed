[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# CSV reader speed — WASM entry (single-pass rewrite)

A byte-level transducer that answers every case exactly the way
csv-reader 1.0.0 does, but without parsing JSON values, unescaping
text, or re-escaping output. The CSV state machine runs DIRECTLY on
the raw JSON bytes of each case's `text` value, and clean raw spans
are copied verbatim into the output JSON string.

## How it works

`parser.wasm` (compiled from `transducer.ts` with AssemblyScript,
`--optimize --enable simd --runtime stub --shrinkLevel 2 --noAssert`)
works directly on raw memory:

1. **JSON scan** — walks the raw `cases.json` bytes, generically skips
   values, and locates each case's `text` string span and `header`
   flag. The text is never unescaped or copied.
2. **CSV state machine, single pass** — a faithful port of
   `solve.js` on the raw span: BOM drop, LF/CRLF record ends, lone-CR
   drop (`stray_cr`), quoted fields with doubled quotes, CRLF/lone-CR
   inside quotes read as LF, `quote_junk`, unterminated-quote re-read
   as unquoted, `short_row` / `long_row` pad/cut. Delimiter scans use
   128-bit SIMD masked loads (`,` and `\` in unquoted fields, `\`
   only in quoted fields, where a raw comma is content).
3. **Verbatim output** — the scorer compares answers by JSON value,
   so the output's escaping need not match `JSON.stringify`: clean
   raw spans are copied verbatim (they are already valid JSON string
   bytes), and escapes are copied verbatim when they are content
   (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\t`, `\uXXXX` all decode to
   the same value in the output). The only substitutions are where
   the CSV semantics transform the value: a doubled quote `""` emits
   one `\"`, and a CR/CRLF inside quotes emits `\n`. Parse and emit
   are fused: each field is written to the output as soon as it is
   read; only a long row's extra fields are kept (in a scratch
   buffer), for the error's `extra` array.

`main.ts` copies `/input/cases.json` into WASM memory, calls
`process()`, and writes the returned bytes to `/output/answers.json`
(the WASM memory view is written directly, with no extra copy).
If the WASM path fails, it falls back to `solve.js`.

## Files

- `main.ts` — entrypoint (Node 22), drives the WASM transducer.
- `parser.wasm` — the compiled transducer (6,644 bytes).
- `transducer.ts` — the AssemblyScript source.
- `solve.js` — the correct dependency-free JS drop-in for
  csv-reader 1.0.0 (also the fallback `run({text, header})`).

## Verification (local)

- Practice set: 6/6 cases match the reference by value,
  byte-identical across runs, `process()` ~41 ms warm / ~52 ms cold
  first call (v4: ~72 ms warm / ~104 ms cold; v3: ~93 ms; v2 JS:
  1,460 ms on the dev server).
- Differential fuzz vs csv-reader 1.0.0: 6,000/6,000 random +
  broken-CSV cases match (unterminated quotes, junk after closing
  quotes, doubled quotes, embedded CR/LF/CRLF, stray CRs, short/long
  rows, empty lines, BOM, control chars, non-ASCII, lone surrogates).
