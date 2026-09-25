/** Activity 的公开 CLI 参数与命令结构须能从帮助文本直接发现。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const entry = path.resolve("src/cli/index.ts");
const runHelp = (...args: string[]): string => {
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, "activity", ...args, "--help"], {
    cwd: path.resolve("."), encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const search = runHelp("search");
assert.match(search, /Commands:[\s\S]*semantic/u);
assert.match(search, /<query\.\.\.>/u);
assert.doesNotMatch(search, /--semantic/u);
assert.match(runHelp("search", "semantic"), /<query\.\.\.>/u);
const sessions = runHelp("sessions");
assert.match(sessions, /\[limit\]/u);
const activityHelp = runHelp();
assert.doesNotMatch(activityHelp, /\n\s+(?:serve|clear|suggestions)\b/u);
const digest = runHelp("digest");
assert.match(digest, /--lookback\s+<minutes>/u);
assert.match(digest, /--max-analyzed\s+<count>/u);
assert.match(runHelp("report"), /--force/u);
assert.match(runHelp("report"), /--skeleton/u);
assert.match(runHelp("summary"), /--narrative/u);
