/** 普通记忆 REST 仅操作活动事实；归档行只能经显式归档入口恢复。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-active-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const active = await memory.writeEntry({ content: "Current fact." });
  const source = await memory.writeEntry({ content: "Archived fact." });
  assert.ok(active.entry && source.entry);
  const archive = await memory.archiveEntry(source.entry.id, true);
  assert.ok(archive.entry);

  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-active", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-active-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const base = `http://127.0.0.1:${api.port}/api/memories`;
  const headers = { authorization: "Bearer test-only-memory-token", "content-type": "application/json" };
  const put = async (id: string) => await fetch(`${base}/${id}`, { method: "PUT", headers,
    body: JSON.stringify({ content: "Changed by ordinary REST." }) });
  const remove = async (id: string) => await fetch(`${base}/${id}`, { method: "DELETE", headers });

  assert.equal((await fetch(`${base}/${active.entry.id}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/${archive.entry.id}`, { headers })).status, 404);
  assert.equal((await put(archive.entry.id)).status, 404);
  assert.equal((await remove(archive.entry.id)).status, 404);
  assert.equal((await put("missing-active-id")).status, 404);
  assert.equal((await remove("missing-active-id")).status, 404);
  const stillArchived = (await memory.listArchivedEntries()).entries.find((entry) => entry.id === archive.entry!.id);
  assert.equal(stillArchived?.content, "Archived fact.");

  const updated = await put(active.entry.id);
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { id: string; content: string };
  assert.equal(updatedBody.id, active.entry.id);
  assert.equal(updatedBody.content, "Changed by ordinary REST.");
  assert.equal((await memory.getEntry(active.entry.id))?.content, "Changed by ordinary REST.");
  const deleted = await remove(active.entry.id);
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.equal(await memory.getEntry(active.entry.id), undefined);
  const restored = await fetch(`${base}/archive/${archive.entry.id}/restore`, { method: "POST", headers });
  assert.equal(restored.status, 200);
  const body = await restored.json() as { memory: { id: string; content: string } };
  assert.equal(body.memory.content, "Archived fact.");
  assert.equal((await fetch(`${base}/${body.memory.id}`, { headers })).status, 200);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP active-only tests passed");
