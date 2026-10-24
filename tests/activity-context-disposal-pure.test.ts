import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// Evaluate only allowlisted lifecycle declarations with fake storage, discovery,
// requests and timers. Never import AgentSession, ActivityStore or owner modules.
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(ast: ts.SourceFile, name: string): string {
  const item = ast.statements.find(entry => (ts.isFunctionDeclaration(entry) || ts.isClassDeclaration(entry)) ? entry.name?.text === name
    : ts.isVariableStatement(entry) && entry.declarationList.declarations.some(value => value.name.getText(ast) === name));
  assert.ok(item, `Missing declaration ${name}`);
  return item.getText(ast).replace(/^export /, "");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invoke(target: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const method = target[name];
  assert.ok(typeof method === "function", `Missing method ${name}`);
  const value: unknown = Reflect.apply(method, target, args);
  return value;
}
function pending(target: Record<string, unknown>, name: string, ...args: unknown[]): Promise<unknown> {
  const value = invoke(target, name, ...args);
  assert.ok(value instanceof Promise);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function microtasks(): Promise<void> { for (let index = 0; index < 30; index += 1) await Promise.resolve(); }

const sessionSource = source("agent/AgentSession.ts");
const sessionClass = sessionSource.statements.find(entry => ts.isClassDeclaration(entry) && entry.name?.text === "AgentSession");
assert.ok(sessionClass && ts.isClassDeclaration(sessionClass));
const memberNames = ["activityContextAbort", "pendingActivityContextTasks", "activityContextClose", "trackActivityContextTask", "closeActivityContext", "activityContextPrompt", "readActivityContextPrompt", "close"];
const members = sessionClass.members.filter(entry => entry.name && memberNames.includes(entry.name.getText(sessionSource)))
  .map(entry => entry.getText(sessionSource)).join("\n");
const activitySource = source("activity/chatContext.ts");
const activityDeclarations = ["relevantLookbackMs", "relevantThreshold", "relevantTimeoutMs", "activityContextForTurn", "relevantActivityForChat"]
  .map(name => declaration(activitySource, name)).join("\n");
const clientSource = source("runtime/memory/client.ts");
const clientClass = clientSource.statements.find(entry => ts.isClassDeclaration(entry) && entry.name?.text === "AgentMemoryClient");
assert.ok(clientClass && ts.isClassDeclaration(clientClass));
const clientMembers = clientClass.members.filter(entry => entry.name && ["call", "embeddingRuntime"].includes(entry.name.getText(clientSource)))
  .map(entry => entry.getText(clientSource)).join("\n");
const clientDeclaration = `class AgentMemoryClient { root = '/synthetic-agent'; configRoot = '/synthetic-agent'; ${clientMembers} }`;
const now = new Date("2026-10-24T00:00:00Z");
const descriptor = { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "synthetic", source: "local", dimensions: 1 };

type RequestMode = "ready" | "descriptor-pending" | "embed-pending";
function fixture(options: { delayedOpen?: boolean; delayedDiscovery?: boolean; delayedDiscoveryAt?: number; requestMode?: RequestMode; failDiscovery?: boolean } = {}) {
  const opened = deferred<void>();
  const discovered = deferred<Record<string, unknown>>();
  const owner = { identity: "synthetic-owner" };
  const counters = { discoveries: 0, requests: [] as string[], storeReads: 0, storeCloses: 0, requestAborts: 0 };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let closed = false;
  const checkOpen = () => { assert.equal(closed, false, "candidate must not access a closed store"); counters.storeReads += 1; };
  const store = {
    open: async () => { if (options.delayedOpen) await opened.promise; },
    close: async () => { closed = true; counters.storeCloses += 1; },
    listOcrEmbeddingRows: () => { checkOpen(); return [{ sessionId: "synthetic-session", createdAt: now.getTime(), embedding: new Float32Array([1]) }]; },
    getSessionRecord: () => { checkOpen(); return { startedAt: now.toISOString(), endedAt: now.toISOString() }; },
    getAnalysis: () => { checkOpen(); return { title: "synthetic title", summary: "synthetic summary" }; }
  };
  class FakeActivityStore {
    open = store.open;
    close = store.close;
    listOcrEmbeddingRows = store.listOcrEmbeddingRows;
    getSessionRecord = store.getSessionRecord;
    getAnalysis = store.getAnalysis;
  }
  const discoverMemoryOwner = async () => {
    counters.discoveries += 1;
    if (options.failDiscovery) throw new Error("synthetic discovery rejection");
    if (options.delayedDiscovery || options.delayedDiscoveryAt === counters.discoveries) return await discovered.promise;
    return owner;
  };
  const memoryRequest = async (_owner: unknown, action: string, _payload: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    counters.requests.push(action);
    const stalled = action === "embedding.runtime" && options.requestMode === "descriptor-pending"
      || action === "embedding.embed" && options.requestMode === "embed-pending";
    if (stalled) return await new Promise<never>((_resolve, reject) => {
      const abort = () => { counters.requestAborts += 1; reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return action === "embedding.runtime" ? descriptor : { embeddings: [[1]], fingerprint: "synthetic", dimensions: 1 };
  };
  const bindings = {
    AbortController, AbortSignal, Float32Array, Promise, Set, path,
    globalAgentDir: () => "/synthetic-agent", globalConfigDir: () => "/synthetic-agent", AGENT_DATABASE_FILE: "agent.sqlite",
    fs: { access: async () => undefined }, ActivityStore: FakeActivityStore,
    discoverMemoryOwner, memoryRequest,
    isBareGreeting: (input: string) => input === "hi", recentActivityForGreeting: () => "synthetic greeting",
    cosineSimilarity: () => 1, redactSecrets: (value: string) => value,
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 350); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); }
  };
  const text = `${activityDeclarations}\n${clientDeclaration}\nclass Harness {
    activeConfig = {activity: {enabled: true, outputDirectory: '/synthetic-activity'}};
    options = {};
    memoryEmbeddingService = new AgentMemoryClient();
    acpClient = undefined;
    sessionSearchIndex = {close: async () => undefined};
    emotionAnalysisScheduler = {close: async () => undefined};
    titleAbort = new AbortController(); titleTask = undefined;
    pendingMemoryTasks = new Set(); pendingSkillExtraction = undefined;
    closed = false; pendingCrystalTasks = new Set();
    memoryRetriever = {close: () => undefined}; localMemory = {close: () => undefined}; crystalService = {close: () => undefined};
    recorder = {close: async () => undefined}; takeRelatedUsage() {return undefined;}
    ${members}
  }
  return new Harness();`;
  const js = stripTypeScriptTypes(`function build() {${text}}`, { mode: "strip" });
  const harness: unknown = new Function(...Object.keys(bindings), `${js}\nreturn build();`)(...Object.values(bindings));
  assert.ok(record(harness));
  return {
    harness, counters, opened, discovered, owner,
    expire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    prompt(signal?: AbortSignal) { return pending(harness, "activityContextPrompt", "synthetic relevant query", now, signal); },
    close() { return pending(harness, "close"); }
  };
}

test("cold activity recall remains available and retains the 350ms budget", async () => {
  const f = fixture();
  const result = await f.prompt();
  assert.ok(record(result)); assert.equal(result.kind, "relevant");
  assert.match(String(result.text), /synthetic title/u);
  assert.equal(f.counters.discoveries, 2, "descriptor and embed preserve ordinary cold discovery");
  assert.deepEqual(f.counters.requests, ["embedding.runtime", "embedding.embed"]);
  await f.close(); assert.equal(f.counters.storeCloses, 1);
});

test("timeout returns promptly but disposal joins late startup without touching closed storage", async () => {
  const f = fixture({ delayedDiscovery: true });
  const prompt = f.prompt(); await microtasks();
  assert.equal(f.counters.discoveries, 1); f.expire();
  assert.equal(await prompt, undefined); assert.equal(f.counters.storeCloses, 1);
  let finished = false; const close = f.close().then(() => { finished = true; });
  await microtasks(); assert.equal(finished, false, "close cannot abandon an admitted owner startup");
  f.discovered.resolve(f.owner); await close; await microtasks();
  assert.deepEqual(f.counters.requests, [], "abort after discovery suppresses descriptor RPC");
  assert.equal(f.counters.storeReads, 0);
  assert.equal(await f.prompt(), undefined); assert.equal(f.counters.discoveries, 1);
  await f.close();
});

test("close seals admission while ActivityStore.open is suspended", async () => {
  const f = fixture({ delayedOpen: true });
  const prompt = f.prompt(); await microtasks();
  let finished = false; const close = f.close().then(() => { finished = true; });
  await microtasks(); assert.equal(finished, false);
  f.opened.resolve(); await prompt; await close;
  assert.equal(f.counters.discoveries, 0); assert.equal(f.counters.storeCloses, 1);
});

for (const requestMode of ["descriptor-pending", "embed-pending"] as const) {
  test(`close aborts ${requestMode} RPC and preserves closed-store guards`, async () => {
    const f = fixture({ requestMode });
    const prompt = f.prompt(); await microtasks();
    assert.ok(f.counters.requests.includes(requestMode === "descriptor-pending" ? "embedding.runtime" : "embedding.embed"));
    const before = f.counters.storeReads;
    const close = f.close(); await microtasks(); f.expire();
    await prompt; await close;
    assert.equal(f.counters.requestAborts, 1);
    assert.equal(f.counters.storeReads, before, "aborted candidate does not perform later store reads");
    assert.equal(f.counters.storeCloses, 1);
  });
}

test("late discovery rejection is consumed and repeated disposal settles", async () => {
  const f = fixture({ delayedDiscovery: true });
  const prompt = f.prompt(); await microtasks(); f.expire(); await prompt;
  const first = f.close(); const second = f.close();
  f.discovered.reject(new Error("synthetic late startup failure"));
  await Promise.all([first, second]); assert.deepEqual(f.counters.requests, []);
});

test("already-aborted parent never admits discovery", async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  assert.equal(await f.prompt(abort.signal), undefined);
  assert.equal(f.counters.discoveries, 0); await f.close();
});


test("disappearing owner during embed is joined after prompt timeout", async () => {
  const f = fixture({ delayedDiscoveryAt: 2 });
  const prompt = f.prompt(); await microtasks();
  assert.equal(f.counters.discoveries, 2);
  assert.deepEqual(f.counters.requests, ["embedding.runtime"]);
  const reads = f.counters.storeReads;
  f.expire(); assert.equal(await prompt, undefined);
  assert.equal(f.counters.storeCloses, 1);
  let finished = false;
  const close = f.close().then(() => { finished = true; });
  await microtasks(); assert.equal(finished, false);
  f.discovered.resolve(f.owner); await close;
  assert.deepEqual(f.counters.requests, ["embedding.runtime"], "late rediscovery cannot start embedding RPC");
  assert.equal(f.counters.storeReads, reads, "late embed candidate never reads closed storage");
});
