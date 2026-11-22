[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/a25822457/makefun-csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Faster csv-reader

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` answers
exactly as the reference does on every input — `{columns, rows, errors}` —
including its broken-row policy (stray CRs, quote junk, unterminated quotes,
short and long rows), and `main.ts` is the driver the harness runs.

How it gets faster (v2): the hot path has no regex and allocates no object
per field. The line probe uses cached `indexOf` scans (each delimiter class
is swept once over the text in C++), clean lines are split in one go,
unquoted fields scan with a tight `charCodeAt` loop, and quoted fields jump
from quote to quote with `indexOf`; only multiline / doubled-quote segments
go through a slow path. The field readers report through shared slots
instead of a fresh object per field. The driver stringifies each case's
columns / rows / errors arrays on their own (byte-identical to one
`JSON.stringify` of the whole answers array, but faster), and it keeps
TurboFan off (`--no-turbofan`): for a single-shot run, Maglev's quick
mid-tier code beats paying TurboFan's ~35 ms compile per hot function plus
its deopt/reopt churn. The careful per-field parser mirrors the reference
rule for rule, so broken rows come out identical.

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
