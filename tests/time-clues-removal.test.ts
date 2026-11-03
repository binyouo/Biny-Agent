import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const { stdout } = await promisify(execFile)(process.execPath,
  ["--import", import.meta.resolve("tsx"), "src/cli/index.ts", "memory", "--help"], { timeout: 30_000 });

assert.doesNotMatch(stdout, /\b(?:timeline|ignore-clue|seen-clue)\b/u);
assert.match(stdout, /\bfacts\b/u);
assert.match(stdout, /\bindex-facts\b/u);
assert.match(stdout, /\bdate-ref\b/u);
assert.match(stdout, /\bcalendar\b/u);
