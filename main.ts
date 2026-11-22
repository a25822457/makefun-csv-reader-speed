// Driver for the csv-reader-speed entry: reads every case from the input
// directory, answers each one alone with run() from solve.js, and writes
// the answers in order to the output directory as answers.json.
// Runs on Node 22; the harness mounts /input and /output, and outside a
// container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for them.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for all of solve.js's work, as the
// house baseline's driver does, and keep TurboFan off too: for a
// single-shot run like this one, Maglev's quick mid-tier code beats paying
// TurboFan's ~35 ms compile per hot function plus its deopt/reopt churn.
// Both flags are set before the import so they apply to solve.js.
setFlagsFromString('--no-incremental-marking --no-turbofan');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => { columns: unknown; rows: unknown; errors: unknown };
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: { columns: unknown; rows: unknown; errors: unknown }[] = [];
for (const c of cases) answers.push(run(c.input));

// Serialize per part instead of one JSON.stringify(answers): stringifying
// each case's columns / rows / errors arrays on their own is markedly
// faster in V8 than one traversal of the whole nested structure, and the
// bytes are identical (verified: same string as JSON.stringify(answers)).
// Key order is fixed by run(), which returns {columns, rows, errors}.
let out = '[';
for (let i = 0; i < answers.length; i++) {
  if (i) out += ',';
  const a = answers[i];
  out +=
    '{"columns":' +
    JSON.stringify(a.columns) +
    ',"rows":' +
    JSON.stringify(a.rows) +
    ',"errors":' +
    JSON.stringify(a.errors) +
    '}';
}
out += ']';
writeFileSync(join(outDir, 'answers.json'), out);
