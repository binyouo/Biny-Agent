import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { agentDir, createSessionFile, listSessionFilePaths, sessionIdFromFile } from "../src/session/store.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("心跳接续旧记录、互斥执行并在释放后交接，损坏绑定不静默换身份", { timeout: 30_000 }, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-owner-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const runtimes: CommandRuntime[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pending: Promise<boolean> | undefined;
  let requests = 0;
  const bodies: string[] = [];
  const deadline = setTimeout(() => started.reject(new Error("Heartbeat did not reach provider")), 10_000);
  context.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    requests++;
    bodies.push(input instanceof Request ? await input.clone().text() : String(init?.body));
    if (requests === 1) { started.resolve(); await release.promise; }
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"HEARTBEAT_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const config = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: "fixture",
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://heartbeat-owner.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: { fixture: { provider: "fixture", model: "fixture", contextWindow: 128_000, capabilities: { tools: true, reasoning: false, streaming: true } } },
      thinking: { ...defaultConfig.thinking, enabled: false }, checkpoints: { enabled: false },
      chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "none", skillExtraction: { enabled: false, minToolCalls: 5 } },
      context: { ...defaultConfig.context, identity: { enabled: false, userEnabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    const options = { configStore: { load: async () => config, save: async () => {} } };
    for (let index = 0; index < 2; index++) runtimes.push(await createCommandRuntime(root, options));
    const legacyId = "heartbeat-00000000-0000-4000-8000-000000000001";
    const legacy = await createSessionFile(root, legacyId, Buffer.from(JSON.stringify({ type: "user_message", content: "Previous heartbeat context", metadata: { source: "heartbeat" } }) + "\n"));
    pending = runtimes[0]!.heartbeat.triggerNow();
    await started.promise;
    clearTimeout(deadline);
    assert.equal(await runtimes[1]!.heartbeat.triggerNow(), false);
    assert.match(runtimes[1]!.heartbeat.status().lastError ?? "", /already owned/u);
    assert.equal(requests, 1, "the second owner cannot dispatch while the shared session is leased");
    release.resolve();
    assert.equal(await pending, true, runtimes[0]!.heartbeat.status().lastError);
    assert.equal(await runtimes[1]!.heartbeat.triggerNow(), true, runtimes[1]!.heartbeat.status().lastError);
    assert.equal(requests, 2);
    assert.ok(bodies[0]?.includes("Previous heartbeat context"), "first upgraded run restores the legacy conversation");
    assert.ok(bodies[1]?.includes("HEARTBEAT_OK"), "another runtime restores the prior owner's output");
    assert.deepEqual((await listSessionFilePaths(root)).filter(file => sessionIdFromFile(file).startsWith("heartbeat-")), [legacy]);
    const events = await readSessionEvents(legacy);
    assert.equal(events.filter(event => event.type === "user_message").length, 3);
    const bindingPath = path.join(agentDir(root), "heartbeat-session");
    assert.equal((await fs.readFile(bindingPath, "utf8")).trim(), legacyId);
    await fs.writeFile(bindingPath, "broken binding");
    assert.equal(await runtimes[0]!.heartbeat.triggerNow(), false);
    assert.match(runtimes[0]!.heartbeat.status().lastError ?? "", /Invalid heartbeat session binding/u);
    assert.equal(requests, 2);
    assert.deepEqual(await readSessionEvents(legacy), events);
    assert.equal(await fs.readFile(bindingPath, "utf8"), "broken binding");
  } finally {
    clearTimeout(deadline);
    release.resolve();
    await pending;
    for (const runtime of runtimes) await runtime.close();
    context.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
