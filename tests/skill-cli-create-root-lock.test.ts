import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Command } from "commander";
import { registerSkillCommands } from "../src/cli/commands/skills.js";
import { withGlobalConfigWriteLock } from "../src/config/versioned.js";

function observeRootInspection(context: TestContext, root: string): () => Promise<void> {
  const inspected = gate(), lstat = fs.lstat;
  context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const result = await lstat(...args);
    if (String(args[0]) === root) inspected.resolve();
    return result;
  });
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inspected.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Managed-root lock was never requested.")), 10_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
}

const document = (name: string, body: string) => `---\nname: ${name}\ndescription: Synthetic report workflow.\n---\n\n${body}\n`;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(action: (f: { root: string; managed: string; source: string; target: string; run(name?: string): Promise<void> }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-cli-create-lock-"));
  const old = process.env.BINY_AGENT_DIR, exitCode = process.exitCode;
  const managed = path.join(root, "state", "skills"), source = path.join(root, "input.md"), target = path.join(managed, "weekly-report");
  process.env.BINY_AGENT_DIR = path.join(root, "state"); process.exitCode = undefined;
  try {
    await fs.writeFile(source, document("weekly-report", "CLI_SOURCE"));
    await action({ root, managed, source, target, run: async (name = "weekly-report") => {
      const program = new Command(); registerSkillCommands(program, root);
      await program.parseAsync(["skill", "create", name, "--file", source], { from: "user" });
    } });
  } finally {
    if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
    process.exitCode = exitCode; await fs.rm(root, { recursive: true, force: true });
  }
}

test("CLI create waits for a managed-root publisher and preserves its completed document", async t => fixture(async f => {
  const acquired = gate(), release = gate();
  const owner = withGlobalConfigWriteLock(f.managed, async () => {
    acquired.resolve(); await release.promise;
    await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, "SKILL.md"), document("weekly-report", "OTHER_PUBLISHER"));
  });
  await acquired.promise;
  let pending: Promise<void> | undefined;
  try {
    const inspected = observeRootInspection(t, await fs.realpath(f.managed));
    pending = f.run();
    await Promise.race([inspected(), pending.then(() => { assert.fail("CLI completed before the managed-root publisher released its lock."); })]);
    await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
    release.resolve(); await owner; await pending;
    assert.equal(process.exitCode, 1);
    assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), document("weekly-report", "OTHER_PUBLISHER"));
    assert.equal(await fs.readFile(f.source, "utf8"), document("weekly-report", "CLI_SOURCE"));
  } finally { release.resolve(); await Promise.allSettled([owner, ...(pending ? [pending] : [])]); }
}));

test("CLI holds the shared lock from empty reservation through successful publication", async t => fixture(async f => {
  const reserved = gate(), release = gate(); const original = fs.writeFile;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(f.target, "SKILL.md")) { reserved.resolve(); await release.promise; }
    return await original(...args);
  });
  const cli = f.run(); let writer: Promise<void> | undefined; let entered = false;
  try {
    await reserved.promise; assert.deepEqual(await fs.readdir(f.target), []);
    const inspected = observeRootInspection(t, await fs.realpath(f.managed));
    writer = withGlobalConfigWriteLock(f.managed, async () => {
      entered = true;
      assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), document("weekly-report", "CLI_SOURCE"));
    });
    void writer.catch(() => undefined);
    await inspected(); assert.equal(entered, false);
    release.resolve(); await cli; await writer;
    assert.equal(process.exitCode, undefined); assert.ok(entered);
  } finally { release.resolve(); await Promise.allSettled([cli, ...(writer ? [writer] : [])]); }
}));

test("a different managed root does not block ordinary CLI creation", async () => fixture(async f => {
  const acquired = gate(), release = gate();
  const owner = withGlobalConfigWriteLock(path.join(f.root, "other-skills"), async () => { acquired.resolve(); await release.promise; });
  await acquired.promise;
  try { await f.run(); assert.equal(process.exitCode, undefined); assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), document("weekly-report", "CLI_SOURCE")); }
  finally { release.resolve(); await owner; }
}));

test("existing content survives rejection and the shared lock is released", async () => fixture(async f => {
  await fs.mkdir(f.target, { recursive: true }); await fs.writeFile(path.join(f.target, "SKILL.md"), "EXISTING");
  await fs.writeFile(path.join(f.target, "notes.txt"), "SUPPORT");
  await f.run(); assert.equal(process.exitCode, 1);
  assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), "EXISTING");
  assert.equal(await fs.readFile(path.join(f.target, "notes.txt"), "utf8"), "SUPPORT");
  await fs.writeFile(f.source, document("second-report", "SECOND")); process.exitCode = undefined;
  await f.run("second-report"); assert.equal(process.exitCode, undefined);
  assert.equal(await fs.readFile(path.join(f.managed, "second-report", "SKILL.md"), "utf8"), document("second-report", "SECOND"));
}));

test("metadata validation still precedes creation of the managed root", async () => fixture(async f => {
  await fs.writeFile(f.source, "invalid metadata"); await f.run(); assert.equal(process.exitCode, 1);
  await assert.rejects(fs.stat(f.managed), { code: "ENOENT" });
}));

test("failed file publication holds the root through cleanup and releases it for the next create", async t => fixture(async f => {
  const cleaning = gate(), release = gate(); const originalWrite = fs.writeFile, originalRm = fs.rm;
  let conflict = true, holdCleanup = true;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (conflict && String(args[0]) === path.join(f.target, "SKILL.md")) {
      conflict = false; await fs.mkdir(path.join(f.target, "SKILL.md"));
    }
    return await originalWrite(...args);
  });
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (holdCleanup && String(args[0]) === f.target) { holdCleanup = false; cleaning.resolve(); await release.promise; }
    return await originalRm(...args);
  });
  const cli = f.run(); let writer: Promise<void> | undefined; let entered = false;
  try {
    await cleaning.promise;
    const inspected = observeRootInspection(t, await fs.realpath(f.managed));
    writer = withGlobalConfigWriteLock(f.managed, async () => {
      entered = true; await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
    });
    void writer.catch(() => undefined);
    await inspected(); assert.equal(entered, false);
    release.resolve(); await cli; await writer;
    assert.equal(process.exitCode, 1); assert.ok(entered);
    assert.equal(await fs.readFile(f.source, "utf8"), document("weekly-report", "CLI_SOURCE"));
    process.exitCode = undefined; await f.run(); assert.equal(process.exitCode, undefined);
    assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), document("weekly-report", "CLI_SOURCE"));
  } finally { release.resolve(); await Promise.allSettled([cli, ...(writer ? [writer] : [])]); }
}));
