[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Faster csv-reader

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` answers
exactly as the reference does on every input — `{columns, rows, errors}` —
including its broken-row policy (stray CRs, quote junk, unterminated quotes,
short and long rows), and `main.ts` is the driver the harness runs.

How it gets faster: most records are read at line level — one regex scan
finds the next line break, quote or CR, and a clean line is split in one go
instead of walking it character by character. Quoted fields jump from quote
to quote with `indexOf`, and only the rare multiline / doubled-quote
segments go through the careful per-field parser, which mirrors the
reference rule for rule.

## Layout

- `solve.js` — the reader; `run(input)` returns `{columns, rows, errors}`
- `main.ts` — reads `/input/cases.json`, answers each case with `run`,
  writes `/output/answers.json`
- `LICENSE` — MIT

## Local check

On the kit's practice set (6 cases, ~10.5 MB of CSV), the answers match
csv-reader 1.0.0 exactly on every case, at roughly 2–3× less CPU time than
the reference on the same machine (measured locally; the graded heat runs
on the scored set drawn after entries close).
