/** 手动搜索阈值经 HTTP 与 Host 到达 Agent 搜索，非法值不得退回默认召回。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { MemorySearchOptions } from "../src/agent/context/memoryTypes.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-search-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
const searches: Array<{ query: string; options: MemorySearchOptions }> = [];
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const commands = { agent: {
    getLocalMemory: () => memory,
    searchMemory: async (query: string, _paths: string[], options: MemorySearchOptions) => {
      searches.push({ query, options });
      return { matches: [], storeRevision: 0, report: { degraded: undefined } };
    }
  } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-search", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-search-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const url = `http://127.0.0.1:${api.port}/api/memories/search`;
  const headers = { authorization: "Bearer test-only-memory-token", "content-type": "application/json" };
  const search = async (body: Record<string, unknown>) => await fetch(url, {
    method: "POST", headers, body: JSON.stringify({ query: "release checklist", ...body })
  });

  assert.equal((await search({ threshold: 0.8 })).status, 200);
  assert.equal(searches.at(-1)?.options.threshold, 0.8);
  assert.equal((await search({ threshold: 0 })).status, 200);
  assert.equal(searches.at(-1)?.options.threshold, 0, "zero is an explicit threshold");
  assert.equal((await search({})).status, 200);
  assert.equal(searches.at(-1)?.options.threshold, undefined, "omission leaves the configured threshold in force");
  for (const threshold of [-0.1, 1.1, "0.8", null]) {
    assert.equal((await search({ threshold })).status, 400);
  }
  assert.equal(searches.length, 3, "invalid thresholds must not reach search");
  await assert.rejects(client.memory("search", { query: "release checklist", threshold: 2 }), /threshold/u);
  for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(client.memory("search", { query: "release checklist", threshold }), /threshold/u);
  }
  assert.equal(searches.length, 3);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP search threshold tests passed");
