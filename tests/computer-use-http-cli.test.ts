import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const help = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "src/cli/index.ts", "computer", "mcp", "--help"], { encoding: "utf8" });
assert.match(help, /--http/);
assert.match(help, /--port <n>/);
assert.match(help, /--token-path <path>/);
