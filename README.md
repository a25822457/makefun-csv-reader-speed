[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# CSV reader speed — WASM entry

A byte-level transducer that answers every case exactly the way
csv-reader 1.0.0 does, but without parsing JSON values or allocating
per field.

## How it works

`parser.wasm` (compiled from `transducer.ts` with AssemblyScript,
`--optimize --enable simd --runtime stub`) works directly on raw
memory:

1. **JSON scan** — walks the raw `cases.json` bytes, generically skips
   values, and unescapes each case's `text` (`\" \\ \/ \b \f \n \r \t
   \uXXXX`, including surrogate pairs) into a byte buffer. Lone
   surrogates are kept as WTF-8 (`ED A0..BF`) and converted back to
   `\uXXXX` on output.
2. **CSV state machine** — a faithful port of `solve.js` on bytes:
   BOM drop, LF/CRLF record ends, lone-CR drop (`stray_cr`), quoted
   fields with doubled quotes, CRLF/lone-CR inside quotes read as LF,
   `quote_junk`, unterminated-quote re-read as unquoted, `short_row` /
   `long_row` pad/cut. Delimiter scans use 128-bit SIMD masked loads.
3. **JSON emit** — writes `answers.json` bytes directly with
   `JSON.stringify`-identical escaping. A per-field flag (set during
   parsing) lets the emitter skip the escape scan for the ~95% of
   fields that need none.

`main.ts` copies `/input/cases.json` into WASM memory, calls
`process()`, and writes the returned bytes to `/output/answers.json`.
If the WASM path fails, it falls back to `solve.js`.

## Files

- `main.ts` — entrypoint (Node 22), drives the WASM transducer.
- `parser.wasm` — the compiled transducer (12,083 bytes).
- `transducer.ts` — the AssemblyScript source.
- `solve.js` — the correct dependency-free JS drop-in for
  csv-reader 1.0.0 (also the fallback `run({text, header})`).

## Verification (local)

- Practice set: 6/6 cases match the reference, byte-identical across
  runs, ~53 ms (v2 JS: 1,460 ms on the dev server).
- Differential fuzz vs csv-reader 1.0.0: 6,000/6,000 random +
  broken-CSV cases match (unterminated quotes, junk after closing
  quotes, doubled quotes, embedded CR/LF/CRLF, stray CRs, short/long
  rows, empty lines, BOM, control chars, non-ASCII, lone surrogates).
