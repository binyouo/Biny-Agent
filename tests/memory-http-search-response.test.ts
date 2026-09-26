/** 手动记忆搜索的公开响应只暴露命中事实与查询元数据，内部 Host 报告保持原形。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-search-response-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const entry = (await memory.writeEntry({ content: "Release checklist", source: "manual",
    metadataExtra: { provenance: { team: "release" } } })).entry!;
  const internal = { matches: [{ entry, path: `memory://${entry.id}`, excerpt: entry.content, score: 0.88 }],
    storeRevision: 1, report: { included: 1, omitted: [] }, originalQuery: "checklist", rewrittenQuery: "release checklist" };
  const commands = { agent: { getLocalMemory: () => memory, searchMemory: async () => internal } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-search-response", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-search-response", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const response = await fetch(`http://127.0.0.1:${api.port}/api/memories/search`, {
    method: "POST", headers: { authorization: "Bearer test-only-memory-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "checklist" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    results: [{
      id: entry.id, content: entry.content, threadId: null, messageId: null, userId: null,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      metadata: {
        source: entry.source, tags: entry.tags, importance: entry.importance,
        durability: entry.durability, accessCount: entry.accessCount,
        provenance: { team: "release" }
      }, score: 0.88
    }],
    originalQuery: "checklist", rewrittenQuery: "release checklist"
  });
  assert.deepEqual(await client.memory("search", { query: "checklist" }), JSON.parse(JSON.stringify(internal)),
    "Host/CLI result retains its report");
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP search response tests passed");
