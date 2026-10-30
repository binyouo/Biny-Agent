import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendInputHistory, loadInputHistory } from "../src/tui/inputHistory.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";

async function isolated(run: (workspace: string, file: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-recovery-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await ensureAgentDirs(workspace);
    await run(workspace, path.join(agentDir(workspace), "input-history.jsonl"), root);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const record = (input: string) => JSON.stringify({ input });

test("damaged middle and tail records do not hide healthy history or rewrite it", async () => isolated(async (workspace, file) => {
  const content = [record("first"), "{broken", record("second"), '{"input":"torn'].join("\n");
  await writeFile(file, content);
  assert.deepEqual(await loadInputHistory(workspace), ["first", "second"]);
  assert.equal(await readFile(file, "utf8"), content);
}));

test("append separates a torn tail and keeps the next healthy input recoverable", async () => isolated(async (workspace, file) => {
  await appendInputHistory(workspace, "first");
  await appendFile(file, '{"input":"torn');
  const before = await readFile(file, "utf8");
  await appendInputHistory(workspace, "second");
  assert.ok((await readFile(file, "utf8")).startsWith(before));
  assert.deepEqual(await loadInputHistory(workspace), ["first", "second"]);
  await appendInputHistory(workspace, "third");
  assert.deepEqual(await loadInputHistory(workspace), ["first", "second", "third"]);
}));

test("a complete final record without LF survives a later append", async () => isolated(async (workspace, file) => {
  await writeFile(file, record("no final newline"));
  await appendInputHistory(workspace, "next");
  assert.deepEqual(await loadInputHistory(workspace), ["no final newline", "next"]);
}));

test("valid JSON with invalid record shape is ignored without hiding valid multiline text", async () => isolated(async (workspace, file) => {
  await writeFile(file, ['null', '[]', '42', 'true', '"text"', '{}', '{"input":8}', '{"input":"  "}',
    record("line one\nline two"), record("中文 🐈")].join("\r\n"));
  assert.deepEqual(await loadInputHistory(workspace), ["line one\nline two", "中文 🐈"]);
}));

test("the last 100 valid inputs are retained even among malformed records", async () => isolated(async (workspace, file) => {
  const lines = Array.from({ length: 120 }, (_, index) => [record(String(index)), "{broken"]).flat();
  await writeFile(file, lines.join("\n"));
  assert.deepEqual(await loadInputHistory(workspace), Array.from({ length: 100 }, (_, index) => String(index + 20)));
}));

test("empty, missing and ordinary history keep their existing behavior", async () => isolated(async (workspace, file) => {
  assert.deepEqual(await loadInputHistory(workspace), []);
  await appendInputHistory(workspace, "  ");
  assert.deepEqual(await loadInputHistory(workspace), []);
  await writeFile(file, "\n\n");
  assert.deepEqual(await loadInputHistory(workspace), []);
  await appendInputHistory(workspace, "  saved  ");
  await appendInputHistory(workspace, "next\nline");
  assert.deepEqual(await loadInputHistory(workspace), ["saved", "next\nline"]);
}));

test("concurrent complete appends remain distinct records", async () => isolated(async (workspace) => {
  const inputs = Array.from({ length: 20 }, (_, index) => "entry-" + String(index));
  await Promise.all(inputs.map(input => appendInputHistory(workspace, input)));
  assert.deepEqual((await loadInputHistory(workspace)).sort(), inputs.sort());
}));

test("hard-link protection still rejects reads and writes without changing the victim", async () => isolated(async (workspace, file, root) => {
  const victim = path.join(root, "victim");
  const content = record("untouched");
  await writeFile(victim, content);
  await link(victim, file);
  await assert.rejects(loadInputHistory(workspace), /single-link regular file/);
  await assert.rejects(appendInputHistory(workspace, "must fail"), /single-link regular file/);
  assert.equal(await readFile(victim, "utf8"), content);
}));

test("symbolic-link protection is not swallowed as malformed history", { skip: process.platform === "win32" }, async () => isolated(async (workspace, file, root) => {
  const victim = path.join(root, "victim");
  const content = record("untouched");
  await writeFile(victim, content);
  await symlink(victim, file);
  await assert.rejects(loadInputHistory(workspace), /single-link regular file/);
  await assert.rejects(appendInputHistory(workspace, "must fail"), /single-link regular file/);
  assert.equal(await readFile(victim, "utf8"), content);
}));
