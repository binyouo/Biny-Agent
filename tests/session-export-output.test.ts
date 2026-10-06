/** Default CLI export names never overwrite files created by another writer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-output-")));
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const { createSessionFile, ensureAgentDirs } = await import("../src/session/store.js");
const { sessionExportCommand } = await import("../src/cli/commands/sessionTransfer.js");
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

// Existing transfer tests choose explicit output paths and do not cover a default-name race.
test("default export preserves a file created after name selection and reports a fresh output", async (t) => {
  const workspace = path.join(root, "workspace");
  const output = path.join(root, "output");
  await fs.mkdir(workspace);
  await fs.mkdir(output);
  await ensureAgentDirs(workspace);
  const source = '{"type":"user_message","content":"Export this conversation"}\n';
  const sourcePath = await createSessionFile(workspace, "conversation", Buffer.from(source));
  const target = path.join(output, "conversation.json");
  const foreignContent = "Another writer owns this file\n";
  const writeFile = fs.writeFile.bind(fs);
  let inserted = false;
  let foreignMode = 0;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === target && !inserted) {
      inserted = true;
      // Only the OS/filesystem boundary is controlled; selection, export and writes are real.
      await writeFile(target, foreignContent, { flag: "wx", mode: 0o640 });
      foreignMode = (await fs.stat(target)).mode;
    }
    await writeFile(...args);
  });
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const previousCwd = process.cwd();
  try {
    process.chdir(output);
    await sessionExportCommand(workspace, "conversation", { json: true });
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(inserted, true);
  assert.equal(await fs.readFile(target, "utf8"), foreignContent, "the late-created file must not be overwritten");
  assert.equal((await fs.stat(target)).mode, foreignMode, "export must not change the other writer’s permissions");
  const result = JSON.parse(lines[0]!) as { file: string; format: string; baseName: string };
  assert.deepEqual(result, { file: path.join(output, "conversation-1.json"), format: "biny", baseName: "conversation" });
  const bundle = JSON.parse(await fs.readFile(result.file, "utf8")) as { events: unknown[] };
  assert.deepEqual(bundle.events, [{ type: "user_message", content: "Export this conversation" }]);
  assert.equal((await fs.stat(result.file)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(sourcePath, "utf8"), source);
});

test("default export stops when all 1,000 candidate names are occupied without changing them", async (t) => {
  const workspace = path.join(root, "exhausted");
  await fs.mkdir(workspace);
  await ensureAgentDirs(workspace);
  await createSessionFile(workspace, "conversation", Buffer.from('{"type":"user_message","content":"Do not replace existing exports"}\n'));
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const name = suffix === 0 ? "conversation.json" : `conversation-${String(suffix)}.json`;
    await fs.writeFile(path.join(workspace, name), `Existing export ${String(suffix)}\n`);
  }
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await assert.rejects(sessionExportCommand(workspace, "conversation", { json: true }), /1,000.*--out/u);
  } finally {
    process.chdir(previousCwd);
  }
  assert.deepEqual(lines, []);
  assert.equal((await fs.readdir(workspace)).length, 1_000);
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const name = suffix === 0 ? "conversation.json" : `conversation-${String(suffix)}.json`;
    assert.equal(await fs.readFile(path.join(workspace, name), "utf8"), `Existing export ${String(suffix)}\n`);
  }
});

async function fixture(label: string, content = "Saved conversation") {
  const workspace = path.join(root, label);
  await fs.mkdir(workspace);
  await ensureAgentDirs(workspace);
  const source = JSON.stringify({ type: "user_message", content }) + "\n";
  const sourcePath = await createSessionFile(workspace, "conversation", Buffer.from(source));
  return { workspace, source, sourcePath };
}

async function inDirectory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    return await run();
  } finally {
    process.chdir(previous);
  }
}

function captureOutput(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  return lines;
}

test("concurrent default exports with the same name keep both conversations", { timeout: 10_000 }, async (t) => {
  const first = await fixture("concurrent-first", "First conversation");
  const second = await fixture("concurrent-second", "Second conversation");
  const target = path.join(first.workspace, "conversation.json");
  const writeFile = fs.writeFile.bind(fs);
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === target) {
      if (++arrived === 2) release();
      await ready;
    }
    await writeFile(...args);
  });
  const lines = captureOutput(t);
  await inDirectory(first.workspace, async () => {
    await Promise.all([
      sessionExportCommand(first.workspace, "conversation", { json: true }),
      sessionExportCommand(second.workspace, "conversation", { json: true })
    ]);
  });
  const outputs = lines.map((line) => (JSON.parse(line) as { file: string }).file).sort();
  assert.deepEqual(outputs, [path.join(first.workspace, "conversation-1.json"), target]);
  const contents = await Promise.all(outputs.map(async (file) => {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    return (JSON.parse(await fs.readFile(file, "utf8")) as { events: Array<{ content: string }> }).events[0]!.content;
  }));
  assert.deepEqual(contents.sort(), ["First conversation", "Second conversation"]);
  assert.equal(await fs.readFile(first.sourcePath, "utf8"), first.source);
  assert.equal(await fs.readFile(second.sourcePath, "utf8"), second.source);
});

test("default suffix selection leaves existing files, directories and dangling symlinks untouched", async (t) => {
  const f = await fixture("occupied-types");
  const occupied = path.join(f.workspace, "conversation.json");
  const directory = path.join(f.workspace, "conversation-1.json");
  const link = path.join(f.workspace, "conversation-2.json");
  const missing = path.join(root, "must-not-be-created.json");
  await fs.writeFile(occupied, "Keep this export\n");
  await fs.mkdir(directory);
  await fs.symlink(missing, link);
  const lines = captureOutput(t);
  await inDirectory(f.workspace, () => sessionExportCommand(f.workspace, "conversation", { json: true }));
  assert.equal((JSON.parse(lines[0]!) as { file: string }).file, path.join(f.workspace, "conversation-3.json"));
  assert.equal(await fs.readFile(occupied, "utf8"), "Keep this export\n");
  assert.ok((await fs.lstat(directory)).isDirectory());
  assert.equal(await fs.readlink(link), missing);
  await assert.rejects(fs.lstat(missing), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.sourcePath, "utf8"), f.source);
});

for (const code of ["EACCES", "EIO", "ENOSPC"]) {
  test(`default export preserves ${code} failures without retry or success output`, async (t) => {
    const f = await fixture(`write-error-${code}`);
    const fault = Object.assign(new Error(`export write failed: ${code}`), { code });
    const writeFile = fs.writeFile.bind(fs);
    let attempts = 0;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === "string" && path.dirname(args[0]) === f.workspace) {
        attempts += 1;
        throw fault;
      }
      await writeFile(...args);
    });
    const lines = captureOutput(t);
    await inDirectory(f.workspace, async () => {
      await assert.rejects(sessionExportCommand(f.workspace, "conversation", { json: true }), (error: unknown) => error === fault);
    });
    assert.equal(attempts, 1);
    assert.deepEqual(lines, []);
    assert.deepEqual(await fs.readdir(f.workspace), []);
    assert.equal(await fs.readFile(f.sourcePath, "utf8"), f.source);
  });
}

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
for (const format of ["biny", "claude"] as const) {
  test(`actual CLI ${format} export writes a private default file and preserves explicit --out replacement`, { timeout: 30_000 }, async () => {
    const f = await fixture(`cli-${format}`);
    const extension = format === "biny" ? "json" : "jsonl";
    const target = path.join(f.workspace, `conversation.${extension}`);
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "session", "export", "conversation", "--format", format, ...args], {
      cwd: f.workspace,
      env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
      encoding: "utf8",
      timeout: 10_000
    });
    const first = run(["--json"]);
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { file: target, format, baseName: "conversation" });
    const original = await fs.readFile(target, "utf8");
    const content = JSON.parse(original) as { events?: unknown[]; message?: { content: unknown } };
    if (format === "biny") assert.deepEqual(content.events, [{ type: "user_message", content: "Saved conversation" }]);
    else assert.deepEqual(content.message?.content, "Saved conversation");
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);

    await fs.writeFile(target, "Replace this selected output\n");
    await fs.chmod(target, 0o644);
    const replacement = run(["--out", target]);
    assert.equal(replacement.error, undefined);
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal(replacement.stdout, `Exported ${format} session to ${target}\n`);
    const replaced = JSON.parse(await fs.readFile(target, "utf8")) as { events?: unknown[]; message?: unknown };
    if (format === "biny") assert.deepEqual(replaced.events, content.events);
    else assert.deepEqual(replaced.message, content.message);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(f.workspace), [`conversation.${extension}`]);
    assert.equal(await fs.readFile(f.sourcePath, "utf8"), f.source);
  });
}
