// Driver for the csv-reader-speed entry: reads every case from the input
// directory, answers each one alone with run() from solve.js, and writes
// the answers in order to the output directory as answers.json.
// Runs on Node 22; the harness mounts /input and /output, and outside a
// container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for them.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for all of solve.js's work, as the
// house baseline's driver does; set before the import so it applies.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
