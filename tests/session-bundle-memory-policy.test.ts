import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportSessionBundle, importSessionFile, parseSessionImport } from "../src/session/transfer.js";
import { createSessionFile, ensureAgentDirs, listSessionFiles, sessionFilePath } from "../src/session/store.js";
import { readSessionCatalogRecord, refreshSessionIndex, SESSION_CATALOG_MISSING_REVISION, updateSessionCatalogMetadata, writeSessionCatalogRecord } from "../src/session/catalog.js";
import { defaultChatPersonalizationOverride, memoryPolicySchema, resolveChatPersonalization, type ChatPersonalizationOverride } from "../src/personalization/index.js";

async function fixture(run: (source: string, target: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-bundle-memory-policy-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    await mkdir(source); await mkdir(target);
    await ensureAgentDirs(source); await ensureAgentDirs(target);
    await run(source, target, root);
  } finally {
    await refreshSessionIndex(source); await refreshSessionIndex(target);
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function sourceSession(workspace: string, policy?: ChatPersonalizationOverride): Promise<string> {
  const id = "synthetic-private-conversation";
  await createSessionFile(workspace, id, Buffer.from(`${JSON.stringify({ type: "user_message", content: "Synthetic private conversation", time: "2026-11-01T00:00:00.000Z" })}\n`));
  if (policy !== undefined) await updateSessionCatalogMetadata(workspace, id, { personalization: policy, title: "Source title" });
  return id;
}

for (const useMemories of [false, true, "inherit"] as const) {
  for (const contributeMemories of [false, true, "inherit"] as const) {
    test(`native bundle preserves ${String(useMemories)}/${String(contributeMemories)} across workspaces`, () => fixture(async (source, target, root) => {
      const policy = { useMemories, contributeMemories };
      const id = await sourceSession(source, policy);
      const originalRecord = await readSessionCatalogRecord(source, id);
      const exported = await exportSessionBundle(source, id);
      const envelope = JSON.parse(exported.content) as { version: number; personalization: unknown };
      assert.equal(envelope.version, 4, "old readers must reject instead of silently dropping an explicit policy");
      assert.deepEqual(envelope.personalization, policy);
      const bundlePath = path.join(root, "conversation.json");
      await writeFile(bundlePath, exported.content);
      const imported = await importSessionFile(target, bundlePath);
      await refreshSessionIndex(target);
      const record = await readSessionCatalogRecord(target, imported.sessionId);
      assert.notEqual(imported.sessionId, id);
      assert.deepEqual(record?.personalization, policy);
      assert.equal(record?.title, undefined, "unrelated metadata is not imported");
      assert.equal(record?.parentSessionId, undefined);
      assert.equal(imported.eventCount, 1);
      const enabled = memoryPolicySchema.parse({});
      assert.deepEqual(resolveChatPersonalization(enabled, record?.personalization), resolveChatPersonalization(enabled, policy));
      const disabled = memoryPolicySchema.parse({ enabled: false });
      assert.equal(resolveChatPersonalization(disabled, record?.personalization).useMemories, false);
      assert.equal(resolveChatPersonalization(disabled, record?.personalization).contributeMemories, false);
      assert.deepEqual(await readSessionCatalogRecord(source, id), originalRecord);
      assert.equal(await readFile(bundlePath, "utf8"), exported.content);
    }));
  }
}

test("legacy native bundles keep the established inherit policy", () => fixture(async (source, target, root) => {
  const id = await sourceSession(source);
  const exported = await exportSessionBundle(source, id);
  const envelope = JSON.parse(exported.content) as Record<string, unknown>;
  assert.equal(envelope.version, 2);
  assert.equal(envelope.personalization, undefined);
  // Version 2 never promised this field: do not retrospectively grant it meaning.
  envelope.personalization = { useMemories: false, contributeMemories: false };
  const bundlePath = path.join(root, "legacy.json");
  await writeFile(bundlePath, JSON.stringify(envelope));
  const imported = await importSessionFile(target, bundlePath);
  const record = await readSessionCatalogRecord(target, imported.sessionId);
  assert.equal(record?.personalization, undefined);
  assert.deepEqual(resolveChatPersonalization(memoryPolicySchema.parse({}), record?.personalization),
    resolveChatPersonalization(memoryPolicySchema.parse({}), defaultChatPersonalizationOverride));
}));

for (const policy of [undefined, null, {}, { useMemories: false }, { useMemories: false, contributeMemories: "false" }]) {
  test(`policy-bearing bundle rejects invalid policy ${JSON.stringify(policy)} before publication`, () => fixture(async (source, target, root) => {
    const id = await sourceSession(source);
    const envelope = JSON.parse((await exportSessionBundle(source, id)).content) as Record<string, unknown>;
    envelope.version = 4; envelope.personalization = policy;
    const bundlePath = path.join(root, "invalid.json");
    await writeFile(bundlePath, JSON.stringify(envelope));
    await assert.rejects(importSessionFile(target, bundlePath));
    assert.deepEqual(await listSessionFiles(target), []);
  }));
}

test("external conversation imports do not acquire native policy fields", () => {
  const source = JSON.stringify({ type: "user", message: { role: "user", content: "External synthetic conversation" }, personalization: { useMemories: false, contributeMemories: false } });
  assert.equal(parseSessionImport(source, "external.jsonl", { format: "claude" }).personalization, undefined);
});

test("export normalizes legacy chat overrides to only the two supported memory switches", () => fixture(async (source) => {
  const id = await sourceSession(source);
  const now = new Date().toISOString();
  const legacy = { useMemories: false, contributeMemories: false,
    personality: "synthetic retired personality", instructions: "synthetic retired instructions" };
  await writeSessionCatalogRecord(source, { version: 1, sessionId: id, rootSessionId: id,
    personalization: legacy, createdAt: now, updatedAt: now });
  const exported = await exportSessionBundle(source, id);
  const envelope = JSON.parse(exported.content) as { personalization: unknown };
  assert.deepEqual(envelope.personalization, { useMemories: false, contributeMemories: false });
  assert.ok(!exported.content.includes(legacy.personality));
  assert.ok(!exported.content.includes(legacy.instructions));
  assert.deepEqual((await readSessionCatalogRecord(source, id))?.personalization, legacy, "export does not rewrite the source record");
}));

test("new-file reservation precedes policy commit and policy commit precedes transcript contents", () => fixture(async (_source, target) => {
  const id = "ordered-policy-import";
  const content = Buffer.from("synthetic transcript bytes");
  let committed = false;
  const file = await createSessionFile(target, id, content, { beforeWrite: async () => {
    assert.equal((await readFile(sessionFilePath(target, id))).length, 0);
    const now = new Date().toISOString();
    await writeSessionCatalogRecord(target, { version: 1, sessionId: id, rootSessionId: id,
      personalization: { useMemories: false, contributeMemories: false }, createdAt: now, updatedAt: now
    }, { expectedRevision: SESSION_CATALOG_MISSING_REVISION });
    committed = true;
  } });
  assert.equal(committed, true);
  assert.deepEqual(await readFile(file), content);
  assert.equal((await readSessionCatalogRecord(target, id))?.personalization?.contributeMemories, false);
}));

test("real policy revision conflict removes the empty reservation without publishing transcript bytes", () => fixture(async (_source, target) => {
  const id = "conflicting-policy-import";
  const now = new Date().toISOString();
  const existing = { version: 1 as const, sessionId: id, rootSessionId: id,
    personalization: { useMemories: false, contributeMemories: false }, createdAt: now, updatedAt: now };
  await writeSessionCatalogRecord(target, existing);
  await assert.rejects(createSessionFile(target, id, Buffer.from("must not publish"), { beforeWrite: async () => {
    await writeSessionCatalogRecord(target, existing, { expectedRevision: SESSION_CATALOG_MISSING_REVISION });
  } }), /Session catalog revision conflict/u);
  assert.deepEqual(await listSessionFiles(target), []);
  assert.deepEqual(await readSessionCatalogRecord(target, id), existing);
}));

test("an existing transcript refuses import reservation before any policy callback", () => fixture(async (_source, target) => {
  const id = "occupied-policy-import";
  const bytes = Buffer.from("existing transcript bytes");
  const file = await createSessionFile(target, id, bytes);
  let called = false;
  await assert.rejects(createSessionFile(target, id, Buffer.from("replacement"), { beforeWrite: async () => { called = true; } }), /EEXIST/u);
  assert.equal(called, false);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(await readSessionCatalogRecord(target, id), undefined);
}));
