/** Same-runtime session changes use real Runtime/AgentSession methods and only synthetic model streams. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionCatalogRecord, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { BinyTui } from "../src/tui/app.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-title-lifecycle-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  await ensureAgentDirs(root);
  const calls: Array<{ input: string; signal?: AbortSignal; result: ReturnType<typeof deferred<string>> }> = [];
  const starts = new Map<string, ReturnType<typeof deferred<void>>>();
  const callCounts = new Map<number, ReturnType<typeof deferred<void>>>();
  const titles = new Map<string, string>();
  const published = new Map<string, ReturnType<typeof deferred<void>>>();
  let active = 0;
  let maximumActive = 0;
  const model: AgentModel = {
    provider: "synthetic", modelId: "title-lifecycle", supportsTools: false,
    async stream(context, options) {
      let text = "Completed.";
      if (context.systemPrompt?.includes("为这段对话生成简短")) {
        const input = JSON.stringify(context.messages);
        const result = deferred<string>();
        calls.push({ input, signal: options?.signal, result });
        callCounts.get(calls.length)?.resolve();
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        for (const [label, ready] of starts) if (input.includes(label)) ready.resolve();
        try { text = await result.promise; }
        finally { active -= 1; }
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "title-lifecycle",
    providers: { synthetic: { type: "openai-compatible", baseUrl: "http://fixture.invalid", requiresApiKey: false } },
    models: { "title-lifecycle": { provider: "synthetic", model: "title-lifecycle" } },
    activity: { ...defaultConfig.activity, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context,
      compaction: { ...defaultConfig.context.compaction, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const agent = new AgentSession({ workspaceRoot: root, config, model,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission),
    recorder: new SessionRecorder(root) });
  await agent.initialize();
  const commands = { agent, persistenceRoot: root, refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined, close: async () => await agent.close()
  } as unknown as CommandRuntime;
  const runtime = new InteractiveAgentRuntime(commands);
  runtime.subscribe(({ event }) => {
    if (event?.type !== "session.title") return;
    titles.set(event.sessionId, event.title);
    published.get(event.sessionId)?.resolve();
  });
  const started = (label: string) => {
    if (calls.some((call) => call.input.includes(label))) return Promise.resolve();
    let ready = starts.get(label);
    if (!ready) { ready = deferred<void>(); starts.set(label, ready); }
    return bounded(ready.promise, `title request for ${label}`);
  };
  const titlePublished = (sessionId: string) => {
    if (titles.has(sessionId)) return Promise.resolve();
    let ready = published.get(sessionId);
    if (!ready) { ready = deferred<void>(); published.set(sessionId, ready); }
    return bounded(ready.promise, `title publication for ${sessionId}`);
  };
  return { root, agent, runtime, calls, titles, started, titlePublished,
    maximumActive: () => maximumActive,
    async settled() {
      // Observe completion only; every trigger and session transition uses production methods.
      while (agent["titleTask"]) await bounded(agent["titleTask"], "title task settlement");
    },
    async startedCount(count: number) {
      if (calls.length >= count) return;
      const ready = deferred<void>();
      callCounts.set(count, ready);
      await bounded(ready.promise, `title request ${count}`);
    },
    async prompt(input: string) {
      // Explicit continuation provenance disables unrelated delayed emotion analysis;
      // this is still an ordinary root prompt and reaches scheduleTitle in its finally.
      const outcome = await runtime.submitPrompt(input, [], { continuationSource: "title-lifecycle-test" }, undefined,
        { tools: "none", skills: "none" }).completion;
      assert.equal(outcome.status, "completed", outcome.error);
      return runtime.getSnapshot().info.sessionId;
    },
    async seed(label: string) {
      const recorder = new SessionRecorder(root);
      recorder.record({ type: "user_message", content: label });
      await recorder.close();
      return recorder.sessionId;
    },
    async close() {
      await runtime.close();
      for (const call of calls) call.result.resolve("Late ignored title");
      await Promise.allSettled(calls.map((call) => call.result.promise));
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
}

for (const route of ["runtime resume", "TUI fallback resume", "public startDraft"] as const) {
test(`${route} does not lose the current session's requested title`, { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    let secondId = route === "public startDraft" ? "" : await f.seed("SESSION_B");
    const firstId = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    if (route === "public startDraft") secondId = (await f.runtime.startDraft()).sessionId;
    else if (route === "TUI fallback resume") {
      const updates: unknown[] = [];
      // Use the real fallback method without opening a terminal or socket. Only view methods are inert.
      const view = { runtime: f.runtime, clearSessionWriterConflict() {}, announceCurrentSession() {},
        chatContainer: { reset() {} }, dispatch(update: unknown) { updates.push(update); },
        refreshContextUsage: async () => undefined, refreshUsage: async () => undefined };
      await BinyTui.prototype["resumeSession"].call(view as unknown as BinyTui, secondId);
      assert.ok(updates.some((update) => (update as { viewingSessionId?: string }).viewingSessionId === secondId));
    } else await f.runtime.resumeSession(secondId);
    assert.equal(await f.prompt("Continue SESSION_B"), secondId);
    assert.equal(f.calls.length, 1, "only the first title may run while it is pending");
    f.calls[0]!.result.resolve("Title A");
    await f.titlePublished(firstId);
    await f.started("SESSION_B");
    f.calls[1]!.result.resolve("Title B");
    await f.titlePublished(secondId);
    assert.equal((await readSessionCatalogRecord(f.root, firstId))?.title, "Title A");
    assert.equal((await readSessionCatalogRecord(f.root, secondId))?.title, "Title B");
    assert.equal(f.maximumActive(), 1);
  } finally { await f.close(); }
});
}

test("same-session triggers stay coalesced and a failed attempt is not automatically retried", async () => {
  const f = await fixture();
  try {
    const id = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    await f.prompt("A second ordinary prompt");
    await f.prompt("A third ordinary prompt");
    assert.equal(f.calls.length, 1);
    f.calls[0]!.result.reject(new Error("Synthetic title failure"));
    await f.settled();
    assert.equal(f.calls.length, 1, "coalesced same-session triggers cannot replay a failed request");
    assert.equal((await readSessionCatalogRecord(f.root, id))?.title, undefined);
    await f.prompt("Explicit new trigger after failure");
    await f.startedCount(2);
    f.calls[1]!.result.resolve("Title A");
    await f.titlePublished(id);
    await f.settled();
    await f.prompt("Existing title stays unchanged");
    await f.settled();
    assert.equal(f.calls.length, 2);
    assert.equal(f.maximumActive(), 1);
  } finally { await f.close(); }
});

for (const firstResult of ["failure", "invalid"] as const) {
test(`${firstResult} output releases the slot for the requested current session only`, async () => {
  const f = await fixture();
  try {
    const firstId = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    const secondId = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_B");
    if (firstResult === "failure") f.calls[0]!.result.reject(new Error("Synthetic title failure"));
    else f.calls[0]!.result.resolve("Invalid\nmultiline title");
    await f.started("SESSION_B");
    f.calls[1]!.result.resolve("Title B");
    await f.titlePublished(secondId);
    await f.settled();
    assert.equal((await readSessionCatalogRecord(f.root, firstId))?.title, undefined);
    assert.equal(f.calls.length, 2, "the failed original session must not be retried");
    assert.equal(f.maximumActive(), 1);
  } finally { await f.close(); }
});
}

test("rapid switches retain only the latest current-session intent", async () => {
  const f = await fixture();
  try {
    const a = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    const b = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_B");
    const c = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_C");
    await f.prompt("SESSION_C extra trigger");
    assert.equal(f.calls.length, 1);
    f.calls[0]!.result.resolve("Title A");
    await f.titlePublished(a);
    await f.started("SESSION_C");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1]!.input.includes("SESSION_B"), false);
    f.calls[1]!.result.resolve("Title C");
    await f.titlePublished(c);
    await f.settled();
    assert.equal((await readSessionCatalogRecord(f.root, b))?.title, undefined);
    assert.equal(f.maximumActive(), 1);
  } finally { await f.close(); }
});

for (const returnTo of ["away", "original", "superseded", "active-retrigger", "latest"] as const) {
test(`resume ${returnTo} fences pending titles by the requested current session`, async () => {
  const f = await fixture();
  try {
    const a = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    const b = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_B");
    const c = (await f.runtime.startDraft()).sessionId;
    if (returnTo === "original") await f.runtime.resumeSession(a);
    if (returnTo === "superseded") {
      await f.prompt("SESSION_C");
      await f.runtime.resumeSession(b);
    }
    if (returnTo === "active-retrigger") {
      await f.runtime.resumeSession(a);
      await f.prompt("A newer prompt for the already running title");
      await f.runtime.resumeSession(b);
    }
    if (returnTo === "latest") await f.runtime.resumeSession(b);
    f.calls[0]!.result.resolve("Title A");
    await f.titlePublished(a);
    if (returnTo === "latest") {
      await f.started("SESSION_B");
      f.calls[1]!.result.resolve("Title B");
      await f.titlePublished(b);
    }
    await f.settled();
    assert.equal(f.calls.length, returnTo === "latest" ? 2 : 1);
    assert.equal((await readSessionCatalogRecord(f.root, b))?.title, returnTo === "latest" ? "Title B" : undefined);
    assert.equal((await readSessionCatalogRecord(f.root, c))?.title, undefined);
    assert.equal(f.runtime.getSnapshot().info.sessionId, returnTo === "away" ? c : returnTo === "original" ? a : b);
  } finally { await f.close(); }
});
}

for (const rename of ["pending", "running"] as const) {
test(`manual rename of the ${rename} title preserves CAS and the other session's intent`, async () => {
  const f = await fixture();
  try {
    const a = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    const b = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_B");
    await updateSessionCatalogMetadata(f.root, rename === "pending" ? b : a, { title: "Manual title", pinned: true });
    f.calls[0]!.result.resolve("Title A");
    if (rename === "running") {
      await f.started("SESSION_B");
      f.calls[1]!.result.resolve("Title B");
      await f.titlePublished(b);
    }
    await f.settled();
    assert.equal((await readSessionCatalogRecord(f.root, a))?.title, rename === "running" ? "Manual title" : "Title A");
    assert.equal((await readSessionCatalogRecord(f.root, b))?.title, rename === "pending" ? "Manual title" : "Title B");
    assert.equal(f.calls.length, rename === "pending" ? 1 : 2);
    assert.equal(f.titles.has(rename === "pending" ? b : a), false, "no stale generated-title event after a manual rename");
  } finally { await f.close(); }
});
}

test("close aborts the active request and discards the pending intent", async () => {
  const f = await fixture();
  try {
    const a = await f.prompt("SESSION_A");
    await f.started("SESSION_A");
    const b = (await f.runtime.startDraft()).sessionId;
    await f.prompt("SESSION_B");
    await bounded(f.runtime.close(), "close with an uncooperative title model");
    assert.equal(f.calls[0]!.signal?.aborted, true);
    f.calls[0]!.result.resolve("Late title A");
    await f.settled();
    assert.equal(f.calls.length, 1);
    assert.equal(f.titles.size, 0);
    assert.equal((await readSessionCatalogRecord(f.root, a))?.title, undefined);
    assert.equal((await readSessionCatalogRecord(f.root, b))?.title, undefined);
  } finally { await f.close(); }
});
