/** 归档恢复通过带认证的本地 HTTP、Runtime Host 和 SQLite 验证对外响应。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-restore-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace, () => { throw new Error("Restore must not call a model"); });
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const survivor = await memory.writeEntry({ content: "Current durable merged fact." });
  const source = await memory.writeEntry({ content: "Old fact merged into current fact." });
  const missingTargetSource = await memory.writeEntry({ content: "Old fact with removed target." });
  const removedTarget = await memory.writeEntry({ content: "Target that will be removed." });
  const manualSource = await memory.writeEntry({ content: "Manually archived fact." });
  assert.ok(survivor.entry && source.entry && missingTargetSource.entry && removedTarget.entry && manualSource.entry);
  const merged = await memory.archiveEntries([source.entry.id], "llm_merge", { mergedInto: survivor.entry.id });
  const missingTarget = await memory.archiveEntries([missingTargetSource.entry.id], "llm_merge", { mergedInto: removedTarget.entry.id });
  const manual = await memory.archiveEntry(manualSource.entry.id, true);
  assert.ok(merged.entries[0] && missingTarget.entries[0] && manual.entry);
  await memory.deleteEntryById(removedTarget.entry.id);
  for (let index = 0; index < 3; index += 1) {
    const written = await memory.writeEntry({
      content: `HTTP archive scope ${index + 1}`,
      userId: index === 1 ? "user-b" : "user-a"
    });
    assert.ok(written.entry);
    await memory.archiveEntry(written.entry.id, true, { archivedBy: index === 2 ? "run-2" : "run-1" });
  }

  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-restore", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-restore-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const base = `http://127.0.0.1:${api.port}/api/memories/archive`;
  const headers = { authorization: "Bearer test-only-memory-token" };
  const restore = async (id: string) => await fetch(`${base}/${id}/restore`, { method: "POST", headers });
  const scopedResponse = await fetch(`${base}?userId=user-a&offset=1&limit=1`, { headers });
  assert.equal(scopedResponse.status, 200);
  const scopedBody = await scopedResponse.json() as { items: Array<{ userId?: string; metadata?: { source: string }; originalCreatedAt?: string }>; total: number };
  assert.equal(scopedBody.total, 2);
  assert.equal(scopedBody.items.length, 1);
  assert.equal(scopedBody.items[0]?.userId, "user-a");
  assert.equal(typeof scopedBody.items[0]?.metadata?.source, "string");
  assert.equal(typeof scopedBody.items[0]?.originalCreatedAt, "string");
  const combinedResponse = await fetch(`${base}?userId=user-a&runId=run-1`, { headers });
  assert.equal(combinedResponse.status, 200);
  const combinedBody = await combinedResponse.json() as { items: Array<{ content: string }>; total: number };
  assert.deepEqual(combinedBody.items.map((entry) => entry.content), ["HTTP archive scope 1"]);
  assert.equal(combinedBody.total, 1);
  assert.equal((await fetch(`${base}?userId=&limit=1`, { headers })).status, 400);
  assert.equal((await fetch(`${base}?userId=user-a&userId=user-b`, { headers })).status, 400);

  assert.equal((await fetch(`${base}/${merged.entries[0].id}/restore`, { method: "POST" })).status, 401);
  for (const method of ["GET", "DELETE"] as const) {
    const wrongMethod = await fetch(`${base}/${merged.entries[0].id}/restore`, { method, headers });
    assert.equal(wrongMethod.status, 404, `${method} must not invoke the POST-only restore operation`);
    assert.equal((await memory.listArchivedEntries()).entries.some((entry) => entry.id === merged.entries[0].id), true);
    assert.equal((await memory.listMemoryEntries()).entries.some((entry) => entry.content === source.entry!.content), false);
  }
  const mergedResponse = await restore(merged.entries[0].id);
  assert.equal(mergedResponse.status, 200);
  const mergedBody = await mergedResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(mergedBody).sort(), ["memory", "mergedTarget", "success"]);
  assert.equal(mergedBody.success, true);
  assert.deepEqual(mergedBody.mergedTarget, { id: survivor.entry.id, content: survivor.entry.content });
  const restoredMemory = mergedBody.memory as { id: string; content: string; metadata?: { source: string } };
  assert.equal(restoredMemory.content, source.entry.content);
  assert.equal(typeof restoredMemory.metadata?.source, "string");
  assert.notEqual(restoredMemory.id, source.entry.id);
  assert.notEqual(restoredMemory.id, merged.entries[0].id);
  assert.equal((await memory.listMemoryEntries()).entries.some((entry) => entry.id === restoredMemory.id), true);
  assert.equal((await memory.listArchivedEntries()).entries.some((entry) => entry.id === merged.entries[0].id), false);

  for (const archiveId of [missingTarget.entries[0].id, manual.entry.id]) {
    const response = await restore(archiveId);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.mergedTarget, null);
  }
  assert.equal((await restore("missing-archive-id")).status, 404);

  const priorArchivedTotal = (await memory.listArchivedEntries()).total;
  for (let index = 0; index < 201; index += 1) {
    const added = await memory.writeEntry({ content: `Archive page boundary ${index}` });
    assert.ok(added.entry);
    await memory.archiveEntry(added.entry.id, true);
  }
  const defaultPage = await fetch(base, { headers });
  assert.equal(defaultPage.status, 200);
  const defaultBody = await defaultPage.json() as { items: unknown[]; total: number };
  assert.equal(defaultBody.items.length, 50);
  assert.equal(defaultBody.total, priorArchivedTotal + 201);
  const cappedPage = await fetch(`${base}?limit=999`, { headers });
  assert.equal(cappedPage.status, 200);
  const cappedBody = await cappedPage.json() as { items: unknown[]; total: number };
  assert.equal(cappedBody.items.length, 200);
  assert.equal(cappedBody.total, priorArchivedTotal + 201);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP archive restore tests passed");
