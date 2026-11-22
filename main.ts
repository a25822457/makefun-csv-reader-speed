// Driver for the CSV reader entry.
//
// The timed path is a byte-level WASM transducer (parser.wasm, compiled
// from transducer.ts with AssemblyScript): it scans the raw cases.json
// bytes, unescapes each case's text, runs the csv-reader state machine on
// bytes, and emits answers.json directly, so it never parses JSON values
// or allocates per field. If the WASM path fails for any reason, it falls
// back to solve.js (the correct JS drop-in for csv-reader 1.0.0).

import { setFlagsFromString } from "node:v8";
import fs from "node:fs";
import { join } from "node:path";

setFlagsFromString("--no-incremental-marking");

// The harness mounts /input and /output on the server; grade-local's
// process driver points at temp dirs via these env vars instead.
const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const INPUT = join(inDir, "cases.json");
const OUTPUT = join(outDir, "answers.json");

const input = fs.readFileSync(INPUT);

let out: Buffer | null = null;

try {
  const wasmBytes = fs.readFileSync(new URL("./parser.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
      abort() {
        throw new Error("wasm abort");
      },
    },
  });
  const exp = instance.exports as any;
  const mem = exp.memory as WebAssembly.Memory;
  const inputPtr = exp.setup(input.length) as number;
  new Uint8Array(mem.buffer, inputPtr, input.length).set(input);
  const outLen = exp.process() as number;
  if (outLen < 0 || (exp.debugCode() as number) !== 0) {
    throw new Error("wasm process failed, debug=" + (exp.debugCode() as number));
  }
  const outPtr = exp.outputPtr() as number;
  out = Buffer.from(new Uint8Array(mem.buffer, outPtr, outLen));
} catch {
  // Fallback: the correct JS implementation in solve.js.
  const { run } = (await import("./solve.js")) as any;
  const cases = JSON.parse(input.toString("utf8"));
  const answers = cases.map((c: any) => run(c.input));
  out = Buffer.from(JSON.stringify(answers), "utf8");
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUTPUT, out);
