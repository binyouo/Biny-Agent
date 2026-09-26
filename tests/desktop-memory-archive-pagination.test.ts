/** Desktop 公开入口只返回请求的归档页和完整总数。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-archive-page-"));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-archive-workspace-"));
const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
process.env.BINY_RUNTIME_HOST_ENTRY = path.join(root, "missing-runtime-host-entry.js");
let agents: DesktopAgentManager | undefined;
try {
  const storage = new DesktopUserDataStore(root);
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const configStore = createFileConfigStore(root, {
    globalDir: root,
    credentialStore: { persistent: true, get: async () => "test-key", set: async () => undefined, delete: async () => undefined }
  });
  await configStore.save({
    ...defaultConfig,
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
    models: { "test-model": { provider: "active", model: "test-model", contextWindow: 128_000 } },
    thinking: { ...defaultConfig.thinking, enabled: false }
  });
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(workspaceRoot);
  agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
  for (let index = 0; index < 3; index += 1) {
    const content = `Desktop archived page ${index + 1}`;
    await agents.addMemoryEntry(project.id, { content });
    const entry = (await agents.memoryEntries(project.id, 0, 10)).entries.find((item) => item.content === content);
    assert.ok(entry);
    await agents.archiveMemoryEntry(project.id, entry.id, true);
  }
  const first = await agents.archivedMemoryEntries(project.id, 0, 2);
  const second = await agents.archivedMemoryEntries(project.id, 2, 2);
  assert.equal(first.total, 3);
  assert.equal(first.entries.length, 2);
  assert.equal(second.total, 3);
  assert.equal(second.entries.length, 1);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 3);

  const memory = new LocalMemory(workspaceRoot, () => { throw new Error("Restore must not call a model"); });
  let mergedArchiveId: string;
  let staleArchiveId: string;
  let manualArchiveId: string;
  let targetId: string;
  try {
    const target = await memory.writeEntry({ content: "Still active merged fact" });
    const source = await memory.writeEntry({ content: "Restorable merged source" });
    const staleTarget = await memory.writeEntry({ content: "No longer active target" });
    const staleSource = await memory.writeEntry({ content: "Restorable stale source" });
    const manualSource = await memory.writeEntry({ content: "Restorable manual source" });
    assert.ok(target.entry && source.entry && staleTarget.entry && staleSource.entry && manualSource.entry);
    targetId = target.entry.id;
    const merged = await memory.archiveEntries([source.entry.id], "llm_merge", { mergedInto: targetId });
    const stale = await memory.archiveEntries([staleSource.entry.id], "llm_merge", { mergedInto: staleTarget.entry.id });
    const manual = await memory.archiveEntry(manualSource.entry.id, true);
    assert.ok(merged.entries[0] && stale.entries[0] && manual.entry);
    mergedArchiveId = merged.entries[0].id;
    staleArchiveId = stale.entries[0].id;
    manualArchiveId = manual.entry.id;
    await memory.deleteEntryById(staleTarget.entry.id);
  } finally {
    memory.close();
  }
  const mergedRestore = await agents.archiveMemoryEntry(project.id, mergedArchiveId, false);
  assert.deepEqual(mergedRestore.mergedTarget, { id: targetId, content: "Still active merged fact" });
  assert.equal(mergedRestore.totalEntries, 2);
  assert.equal((await agents.archivedMemoryEntries(project.id, 0, 20)).entries.some((entry) => entry.id === mergedArchiveId), false);
  const staleRestore = await agents.archiveMemoryEntry(project.id, staleArchiveId, false);
  assert.equal(staleRestore.mergedTarget, null);
  const manualRestore = await agents.archiveMemoryEntry(project.id, manualArchiveId, false);
  assert.equal(manualRestore.mergedTarget, null);

  const chainMemory = new LocalMemory(workspaceRoot, () => { throw new Error("Chain lookup must not call a model"); });
  let chainSourceArchiveId: string;
  let cycleSourceArchiveId: string;
  let danglingArchiveId: string;
  let finalId: string;
  let cycleFirstId: string;
  try {
    const contents = ["Final chain target", "Older chain C", "Older chain B", "Newer chain A",
      "Cycle X", "Cycle Y", "Cycle source", "Dangling source"];
    const written = await Promise.all(contents.map(async (content) => (await chainMemory.writeEntry({ content })).entry));
    assert.ok(written.every(Boolean));
    const [final, c, b, a, x, y, cycleSource, dangling] = written as NonNullable<typeof written[number]>[];
    assert.ok(final && c && b && a && x && y && cycleSource && dangling);
    finalId = final.id;
    cycleFirstId = x.id;
    const archiveMerged = async (id: string, mergedInto: string, tick: number) => {
      const result = await chainMemory.archiveEntries([id], "llm_merge", {
        mergedInto, now: new Date(Date.UTC(2030, 0, 1, 0, 0, tick))
      });
      assert.ok(result.entries[0]);
      return result.entries[0].id;
    };
    await archiveMerged(c.id, final.id, 1);
    await archiveMerged(b.id, c.id, 2);
    await archiveMerged(x.id, y.id, 3);
    await archiveMerged(y.id, x.id, 4);
    for (let index = 0; index < 26; index += 1) {
      const filler = await chainMemory.writeEntry({ content: `Chain page filler ${index}` });
      assert.ok(filler.entry);
      await chainMemory.archiveEntry(filler.entry.id, true, { now: new Date(Date.UTC(2030, 0, 1, 0, 0, index + 10)) });
    }
    chainSourceArchiveId = await archiveMerged(a.id, b.id, 40);
    cycleSourceArchiveId = await archiveMerged(cycleSource.id, x.id, 41);
    danglingArchiveId = await archiveMerged(dangling.id, "missing-archived-target", 42);
  } finally {
    chainMemory.close();
  }
  const chainPage = await agents.archivedMemoryEntries(project.id, 0, 25, true);
  assert.equal(chainPage.entries.length, 25, "Desktop archive page must remain bounded");
  assert.ok(chainPage.entries.some((entry) => entry.id === chainSourceArchiveId));
  assert.ok(!chainPage.entries.some((entry) => entry.content === "Older chain B"), "chain must resolve across pages");
  assert.deepEqual(chainPage.chains?.[chainSourceArchiveId], { finalId, depth: 2 });
  assert.deepEqual(chainPage.chains?.[cycleSourceArchiveId], { finalId: cycleFirstId, depth: 2 });
  assert.deepEqual(chainPage.chains?.[danglingArchiveId], { finalId: "missing-archived-target", depth: 0 });
  assert.equal((await agents.archivedMemoryEntries(project.id, 0, 1_000)).chains, undefined, "bulk export must not resolve every chain");

  const deepMemory = new LocalMemory(workspaceRoot, () => { throw new Error("Chain lookup must not call a model"); });
  let cappedArchiveId: string;
  let cappedFinalId: string;
  try {
    const nodes: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      const result = await deepMemory.writeEntry({ content: `Deep chain node ${index}` });
      assert.ok(result.entry);
      nodes.push(result.entry.id);
    }
    for (let index = 1; index < 12; index += 1) {
      await deepMemory.archiveEntries([nodes[index]!], "llm_merge", { mergedInto: nodes[index + 1]!,
        now: new Date(Date.UTC(2031, 0, 1, 0, 0, index)) });
    }
    const source = await deepMemory.archiveEntries([nodes[0]!], "llm_merge", { mergedInto: nodes[1]!,
      now: new Date(Date.UTC(2031, 0, 1, 0, 0, 30)) });
    assert.ok(source.entries[0]);
    cappedArchiveId = source.entries[0].id;
    cappedFinalId = nodes[11]!;
  } finally {
    deepMemory.close();
  }
  const deepPage = await agents.archivedMemoryEntries(project.id, 0, 25, true);
  assert.deepEqual(deepPage.chains?.[cappedArchiveId], { finalId: cappedFinalId, depth: 10 });
} finally {
  await agents?.closeAll();
  if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
  else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
