/** 本地 HTTP 显式新增经 Host 写入真实 SQLite；相同正文保留独立来源事实。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-write-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-write", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-write-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const url = `http://127.0.0.1:${api.port}/api/memories`;
  const headers = { authorization: "Bearer test-only-memory-token", "content-type": "application/json" };
  const content = "The release checklist must be reviewed before publishing.";
  const first = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ content, threadId: "thread-one" }) });
  const second = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ content, threadId: "thread-two" }) });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstResult = await first.json() as { id: string; content: string };
  const secondResult = await second.json() as { id: string; content: string };
  assert.equal(firstResult.content, content);
  assert.equal(secondResult.content, content);
  assert.notEqual(firstResult.id, secondResult.id);
  assert.deepEqual(new Set((await memory.listMemoryEntries()).entries.map((entry) => entry.threadId)),
    new Set(["thread-one", "thread-two"]));
  for (let index = 0; index < 101; index += 1) {
    await memory.writeEntry({ content: `Unpaged HTTP fact ${index}`, threadId: "thread-many" });
  }
  const all = await fetch(`${url}?threadId=thread-many`, { headers });
  assert.equal(all.status, 200);
  const allBody = await all.json() as Array<{ id: string }>;
  assert.equal(allBody.length, 101, "unpaged HTTP list must not inherit Host's default 100-entry window");

  // Given a request with nested metadata, the public HTTP contract keeps it nested
  // while the Host and SQLite retain their flat entry representation.
  const nested = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    content: "Keep the release notes concise.", threadId: "thread-metadata",
    metadata: { source: "manual", tags: ["release"], importance: 0.8, durability: "permanent",
      provenance: { review: { owner: "docs", checks: ["legal", "style"] } }, campaign: "autumn" }
  }) });
  assert.equal(nested.status, 201);
  const created = await nested.json() as Record<string, unknown>;
  const createdMetadata = created.metadata as Record<string, unknown>;
  assert.equal(createdMetadata.source, "manual");
  assert.deepEqual(createdMetadata.tags, ["release"]);
  assert.equal(createdMetadata.importance, 0.8);
  assert.equal(createdMetadata.durability, "permanent");
  assert.deepEqual(createdMetadata.provenance, { review: { owner: "docs", checks: ["legal", "style"] } });
  assert.equal(createdMetadata.campaign, "autumn");
  assert.equal(created.source, undefined);
  assert.equal(created.threadId, "thread-metadata");
  assert.equal(created.messageId, null);
  assert.equal(created.userId, null);
  assert.equal((await memory.getEntry(created.id as string))?.source, "manual");

  const fetched = await fetch(`${url}/${created.id as string}`, { headers });
  assert.deepEqual(((await fetched.json()) as { metadata: Record<string, unknown> }).metadata.provenance,
    { review: { owner: "docs", checks: ["legal", "style"] } });
  const listed = await fetch(`${url}?threadId=thread-metadata&limit=1`, { headers });
  const page = await listed.json() as { items: Array<{ metadata: { source: string; campaign: string } }> };
  assert.equal(page.items[0]?.metadata.source, "manual");
  assert.equal(page.items[0]?.metadata.campaign, "autumn");
  const updated = await fetch(`${url}/${created.id as string}`, { method: "PUT", headers,
    body: JSON.stringify({ metadata: { source: "edited", tags: ["published"], campaign: "winter", approved: true } }) });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { metadata: { source: string; tags: string[] } };
  assert.equal(updatedBody.metadata.source, "edited");
  assert.deepEqual(updatedBody.metadata.tags, ["published"]);
  assert.equal((updatedBody.metadata as Record<string, unknown>).campaign, "winter");
  assert.equal((updatedBody.metadata as Record<string, unknown>).approved, true);
  assert.deepEqual((updatedBody.metadata as Record<string, unknown>).provenance,
    { review: { owner: "docs", checks: ["legal", "style"] } });
  assert.equal((await memory.getEntry(created.id as string))?.source, "edited");
  const archived = await memory.archiveEntry(created.id as string, true);
  assert.equal(archived.archived, true);
  const archiveResponse = await fetch(`${url}/archive`, { headers });
  assert.equal(archiveResponse.status, 200);
  const archivePage = await archiveResponse.json() as { items: Array<{ id: string; metadata: Record<string, unknown> }> };
  const archiveEntry = archivePage.items.find((entry) => entry.id === archived.entry?.id);
  assert.equal(archiveEntry?.metadata.campaign, "winter");
  assert.deepEqual(archiveEntry?.metadata.provenance, { review: { owner: "docs", checks: ["legal", "style"] } });
  const restoredResponse = await fetch(`${url}/archive/${archived.entry?.id}/restore`, { method: "POST", headers });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as { memory: { metadata: Record<string, unknown> } };
  assert.equal(restored.memory.metadata.approved, true);
  assert.deepEqual(restored.memory.metadata.provenance, { review: { owner: "docs", checks: ["legal", "style"] } });
  const rejectedSource = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ content: "Rejected metadata source", metadata: { source: 17, campaign: "winter" } }) });
  assert.equal(rejectedSource.status, 400);
  assert.equal((await memory.listMemoryEntries()).entries.some((entry) => entry.content === "Rejected metadata source"), false);
  const reservedMetadata = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ content: "Reserved metadata", metadata: { campaign: { edition: 3 }, accessCount: 900 } }) });
  assert.equal(reservedMetadata.status, 201);
  const reservedBody = await reservedMetadata.json() as { metadata: Record<string, unknown> };
  assert.deepEqual(reservedBody.metadata.campaign, { edition: 3 });
  assert.equal(reservedBody.metadata.accessCount, 0);
  const invalidMetadata = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ content: "Rejected fact", metadata: ["not-an-object"] }) });
  assert.equal(invalidMetadata.status, 400);
  assert.equal((await memory.listMemoryEntries()).entries.some((entry) => entry.content === "Rejected fact"), false);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP manual write tests passed");
