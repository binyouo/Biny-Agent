/** 搜索请求可覆盖查询改写设置，并报告实际用于向量化的查询。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HybridMemoryRetriever } from "../src/agent/context/HybridMemoryRetriever.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemorySearchOptions, MemorySearchResult } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-rewrite-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  await memory.writeEntry({ content: "A release checklist exists." });
  let rewriteEnabled = true;
  let rewriteFails = false;
  const rewrittenInputs: string[] = [];
  const embeddedInputs: string[] = [];
  const embeddingRuntime: EmbeddingModelRuntime = {
    descriptor: { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "test-model",
      displayName: "test model", dimensions: 2, recommendedThreshold: 0.3, source: "local" },
    fingerprint: "test-model",
    embed: async ({ texts }) => {
      embeddedInputs.push(...texts);
      return { embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "test-model",
        model: { kind: "local", model: "multilingual-e5-small" } };
    }
  };
  const retriever = new HybridMemoryRetriever({
    localMemory: memory,
    getEmbeddingRuntime: async () => embeddingRuntime,
    getReadOnlyVectorIndex: () => ({
      status: () => ({ active: { modelFingerprint: "test-model", dimensions: 2,
        vectorCount: 1, createdAt: "now", completedAt: "now" } }),
      search: () => []
    }),
    getThreshold: () => 0.3,
    queryRewriteEnabled: () => rewriteEnabled,
    rewriteQuery: async (query) => {
      rewrittenInputs.push(query);
      if (rewriteFails) throw new Error("test rewrite failure");
      return "published checklist";
    }
  });
  const commands = { agent: {
    getLocalMemory: () => memory,
    searchMemory: async (query: string, paths: string[], options: MemorySearchOptions): Promise<MemorySearchResult> =>
      await retriever.retrieve(query, paths, { ...options, limit: options.limit ?? 5 })
  } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-rewrite", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-rewrite-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const url = `http://127.0.0.1:${api.port}/api/memories/search`;
  const headers = { authorization: "Bearer test-only-memory-token", "content-type": "application/json" };
  const search = async (body: Record<string, unknown>): Promise<MemorySearchResult> => {
    const response = await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ query: "release checklist", ...body }) });
    assert.equal(response.status, 200);
    return await response.json() as MemorySearchResult;
  };

  const disabled = await search({ rewriteQuery: false });
  assert.equal(disabled.originalQuery, "release checklist");
  assert.equal(disabled.rewrittenQuery, undefined);
  assert.deepEqual(rewrittenInputs, []);
  assert.deepEqual(embeddedInputs, ["release checklist"]);

  rewriteEnabled = false;
  const forced = await search({ rewriteQuery: true });
  assert.equal(forced.originalQuery, "release checklist");
  assert.equal(forced.rewrittenQuery, "published checklist");
  assert.deepEqual(rewrittenInputs, ["release checklist"]);
  assert.equal(embeddedInputs.at(-1), "published checklist");

  rewriteFails = true;
  const failed = await search({ rewriteQuery: true });
  assert.equal(failed.originalQuery, "release checklist");
  assert.equal(failed.rewrittenQuery, "release checklist", "failed rewrite reports the original query used for embedding");
  assert.equal(embeddedInputs.at(-1), "release checklist");

  const configuredOff = await search({});
  assert.equal(configuredOff.rewrittenQuery, undefined);
  rewriteEnabled = true;
  rewriteFails = false;
  const configuredOn = await search({});
  assert.equal(configuredOn.rewrittenQuery, "published checklist");
  assert.equal((await search({ rewriteQuery: false })).rewrittenQuery, undefined);

  const invalid = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ query: "release checklist", rewriteQuery: "true" }) });
  assert.equal(invalid.status, 400);
  await assert.rejects(client.memory("search", { query: "release checklist", rewriteQuery: "true" }), /rewriteQuery/u);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP search rewrite tests passed");
