/** Host 的归档分页契约：无参数 CLI 保持全量，带参数只传输请求页。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-archive-page-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const memory = new LocalMemory(root);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
try {
  for (let index = 0; index < 3; index += 1) {
    const written = await memory.writeEntry({
      content: `Archive Host item ${index + 1}`,
      source: "manual",
      userId: index === 1 ? "user-b" : "user-a"
    });
    assert.ok(written.entry);
    await memory.archiveEntry(written.entry.id, true, { archivedBy: index === 2 ? "run-2" : "run-1" });
  }
  const target = await memory.writeEntry({ content: "Active merged target" });
  const mergedSource = await memory.writeEntry({ content: "Host merged source" });
  assert.ok(target.entry && mergedSource.entry);
  const mergedArchive = await memory.archiveEntries([mergedSource.entry.id], "llm_merge", { mergedInto: target.entry.id });
  assert.ok(mergedArchive.entries[0]);
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "archive-page", sessionFile: path.join(root, "session.jsonl"), workspaceRoot: root } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(root, async () => ({ runtime, commands }));
  const client = await connectRuntimeHost(root, { surface: "cli", clientId: "archive-page" });
  assert.ok(client);
  try {
    const page = await client.memory<{ entries: Array<{ content: string }>; total: number }>("archive-list", { offset: 1, limit: 1 });
    assert.equal(page.total, 4);
    assert.equal(page.entries.length, 1);
    const all = await client.memory<{ entries: Array<{ content: string }>; total: number }>("archive-list", {});
    assert.equal(all.entries.length, 4);
    assert.deepEqual(await client.memory("archive-chains", { entryIds: [mergedArchive.entries[0].id] }), {
      [mergedArchive.entries[0].id]: { finalId: target.entry.id, depth: 0 }
    });
    assert.equal((await client.memory<{ id: string } | null>("get", { id: mergedArchive.entries[0].id }))?.id, mergedArchive.entries[0].id);
    await assert.rejects(client.memory("archive-chains", { entryIds: Array(26).fill(mergedArchive.entries[0].id) }), /at most 25/u);
    const scoped = await client.memory<{ entries: Array<{ content: string; userId?: string }>; total: number }>(
      "archive-list", { userId: "user-a", offset: 1, limit: 1 }
    );
    assert.equal(scoped.total, 2);
    assert.equal(scoped.entries.length, 1);
    assert.equal(scoped.entries[0]?.userId, "user-a");
    const combined = await client.memory<{ entries: Array<{ content: string }>; total: number }>(
      "archive-list", { userId: "user-a", runId: "run-1" }
    );
    assert.deepEqual(combined.entries.map((entry) => entry.content), ["Archive Host item 1"]);
    assert.equal(combined.total, 1);
    assert.equal((await client.memory<{ total: number }>("archive-list", { userId: "missing" })).total, 0);
    await assert.rejects(client.memory("archive-list", { limit: "1" }), /limit/u);
    await assert.rejects(client.memory("archive-list", { userId: " " }), /userId/u);
  } finally {
    await client.close();
  }
} finally {
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
