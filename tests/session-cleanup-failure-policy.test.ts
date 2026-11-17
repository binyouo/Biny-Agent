/** Canonical deletion must commit before privacy/recovery sidecars can be removed. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { writeSessionCatalogRecord, readSessionCatalogRecord } from "../src/session/catalog.js";
import { createSessionFile, ensureAgentDirs, SessionNotFoundError } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { resolveChatPersonalization, memoryPolicySchema } from "../src/personalization/index.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-delete-policy-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const prior = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    t.mock.restoreAll();
    if (prior === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  });
  await ensureAgentDirs(workspace);
  const id = "keep-private";
  const original = Buffer.from(`${JSON.stringify({ type: "user_message", content: "private history" })}\n`);
  const file = await createSessionFile(workspace, id, original);
  await writeSessionCatalogRecord(workspace, { version: 1, sessionId: id, rootSessionId: id,
    personalization: { useMemories: false, contributeMemories: false },
    createdAt: "2026-11-16", updatedAt: "2026-11-16" });
  const turns = new TurnStore(workspace, id);
  await turns.save("resume private work", undefined, [{ role: "user", content: "resume private work" }], 3);
  return { workspace, id, file, original, turns };
}

async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  const catalog = await readSessionCatalogRecord(f.workspace, f.id);
  assert.deepEqual(catalog?.personalization, { useMemories: false, contributeMemories: false });
  const policy = resolveChatPersonalization(memoryPolicySchema.parse(undefined), catalog?.personalization);
  assert.equal(policy.useMemories, false);
  assert.equal(policy.contributeMemories, false);
  const turn = await new TurnStore(f.workspace, f.id).load();
  assert.equal(turn?.prompt, "resume private work");
  assert.equal(turn?.completedSteps, 3);
}

for (const code of ["EIO", "ENOSPC"]) {
  test(`failed transcript rename (${code}) preserves privacy and recovery state; retry can delete`, async (t) => {
    const f = await fixture(t);
    const rename = fs.rename;
    const failure = Object.assign(new Error(`controlled transcript rename ${code}`), { code });
    t.mock.method(fs, "rename", async (src: Parameters<typeof fs.rename>[0], dst: Parameters<typeof fs.rename>[1]) => {
      if (src === f.file) throw failure;
      return rename(src, dst);
    });
    await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), error => error === failure);
    assert.deepEqual(await fs.readFile(f.file), f.original);
    await assertPreserved(f);
    t.mock.restoreAll();
    await deleteSessionArtifacts(f.workspace, f.id);
    await assert.rejects(fs.access(f.file), { code: "ENOENT" });
    assert.equal(await readSessionCatalogRecord(f.workspace, f.id), undefined);
    assert.equal(await f.turns.load(), undefined);
  });
}

test("real read-only transcript refusal does not erase its policy or checkpoint", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses file mode write restrictions");
  const f = await fixture(t);
  await fs.chmod(f.file, 0o400);
  try {
    await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), { code: "EACCES" });
    assert.deepEqual(await fs.readFile(f.file), f.original);
    await assertPreserved(f);
  } finally {
    await fs.chmod(f.file, 0o600);
  }
});

test("post-rename failure retains policy and recovery state while tombstone preserves transcript", async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const failure = Object.assign(new Error("controlled truncation EIO after move"), { code: "EIO" });
  let tombstone: string | undefined;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (src: Parameters<typeof fs.rename>[0], dst: Parameters<typeof fs.rename>[1]) => {
    await rename(src, dst);
    if (src === f.file) tombstone = String(dst);
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === f.file) t.mock.method(handle, "truncate", async () => { throw failure; });
    return handle;
  });
  await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), error => error === failure);
  await assert.rejects(fs.access(f.file), { code: "ENOENT" });
  assert.ok(tombstone);
  assert.deepEqual(await fs.readFile(tombstone), f.original);
  await assertPreserved(f);
});

test("confirmed missing transcript still cleans orphan policy and checkpoint and reports absence", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.file);
  await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), SessionNotFoundError);
  assert.equal(await readSessionCatalogRecord(f.workspace, f.id), undefined);
  assert.equal(await f.turns.load(), undefined);
});

test("a fresh AgentSession still reads explicit opt-out after failed deletion", async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (src: Parameters<typeof fs.rename>[0], dst: Parameters<typeof fs.rename>[1]) => {
    if (src === f.file) throw Object.assign(new Error("controlled EIO"), { code: "EIO" });
    return rename(src, dst);
  });
  await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), { code: "EIO" });
  t.mock.restoreAll();
  const { AgentSession } = await import("../src/agent/AgentSession.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { PermissionManager } = await import("../src/permission/PermissionManager.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const config = structuredClone(defaultConfig);
  const agent = new AgentSession({ workspaceRoot: f.workspace, config,
    recorder: new SessionRecorder(f.workspace, f.id), toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }) });
  try {
    const state = await agent.getPersonalizationState();
    assert.equal(state.resolved.useMemories, false);
    assert.equal(state.resolved.contributeMemories, false);
  } finally {
    await agent.close();
  }
});

test("rejected transcript identity is not treated as confirmed absence", async (t) => {
  const f = await fixture(t);
  const retained = `${f.file}.retained`;
  await fs.rename(f.file, retained);
  await fs.symlink(retained, f.file);
  await assert.rejects(deleteSessionArtifacts(f.workspace, f.id), error =>
    error instanceof Error && !(error instanceof SessionNotFoundError));
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readFile(retained), f.original);
  await assertPreserved(f);
});
