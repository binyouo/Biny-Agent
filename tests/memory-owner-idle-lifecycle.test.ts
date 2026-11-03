import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { canonicalMemoryRoot, discoverMemoryOwner, memoryRequest, serveMemoryOwner } from "../src/runtime/memory/transport.js";
import { isProcessAlive } from "../src/runtime/host/lifecycle.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

async function client(root: string): Promise<ChildProcess> {
  const modulePath = new URL("../src/runtime/memory/client.ts", import.meta.url).href;
  const script = `import { AgentMemoryClient } from ${JSON.stringify(modulePath)};
await new AgentMemoryClient(process.env.BINY_AGENT_DIR, process.env.BINY_AGENT_DIR).sleepStatus();
console.log('ready'); process.stdin.resume();`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, BINY_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"]
  });
  const ready = await Promise.race([
    once(child.stdout!, "data").then(([data]) => String(data)),
    once(child, "exit").then(([code]) => { throw new Error(`client exited before ready: ${code}`); }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("client readiness timed out")), 10_000).unref())
  ]);
  assert.match(ready, /ready/);
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.stdin!.end();
  await exited;
}

async function waitForRetirement(retirement: Promise<void>, advance: (ms: number) => void): Promise<void> {
  let retired = false;
  void retirement.then(() => { retired = true; });
  const deadline = Date.now() + 4_000;
  while (!retired && Date.now() < deadline) {
    // 子进程退出和 owner 任务完成不代表 HTTP lease/请求已经收尾；让真实 I/O 与假时钟交替推进。
    await new Promise<void>(resolve => setImmediate(resolve));
    advance(200);
  }
  assert.equal(retired, true, "owner did not retire after its last client exited");
}

test("the shared memory owner retires only after its last client exits", { timeout: 20_000 }, async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  const root = await canonicalMemoryRoot(await mkdtemp(path.join(os.tmpdir(), "biny-memory-idle-")));
  const config = structuredClone(defaultConfig);
  config.context.memory.sleepEnabled = false;
  const owner = new AgentMemoryOwner(root, { load: async () => config, save: async () => {} });
  let retired = false;
  const retirement = Promise.withResolvers<void>();
  const server = await serveMemoryOwner(root, root, owner, { idleGraceMs: 200, onIdle: () => { retired = true; retirement.resolve(); } });
  const children: ChildProcess[] = [];
  try {
    children.push(await client(root), await client(root));
    await stop(children[0]!);
    advance(600);
    assert.equal(retired, false, "a second live client must retain the owner");
    await stop(children[1]!);
    await waitForRetirement(retirement.promise, advance);
    assert.equal(retired, true);
  } finally {
    await Promise.all(children.map(stop));
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

test("owner finishes a detached maintenance operation before retiring", { timeout: 20_000 }, async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  const root = await canonicalMemoryRoot(await mkdtemp(path.join(os.tmpdir(), "biny-memory-maintenance-idle-")));
  const config = structuredClone(defaultConfig);
  config.context.memory.sleepEnabled = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class Models extends LocalEmbeddingManager {
    override async download(): ReturnType<LocalEmbeddingManager["download"]> {
      entered.resolve();
      await release.promise;
      return { model: "multilingual-e5-small", installed: true } as Awaited<ReturnType<LocalEmbeddingManager["download"]>>;
    }
  }
  const owner = new AgentMemoryOwner(root, { load: async () => config, save: async () => {} }, new Models(root));
  let retired = false;
  const retirement = Promise.withResolvers<void>();
  const server = await serveMemoryOwner(root, root, owner, { idleGraceMs: 200, onIdle: () => { retired = true; retirement.resolve(); } });
  const modulePath = new URL("../src/runtime/memory/client.ts", import.meta.url).href;
  const script = `import { AgentMemoryClient } from ${JSON.stringify(modulePath)};
await new AgentMemoryClient(process.env.BINY_AGENT_DIR, process.env.BINY_AGENT_DIR).download('multilingual-e5-small');`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, BINY_AGENT_DIR: root }, stdio: "ignore"
  });
  try {
    await entered.promise;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    advance(600);
    assert.equal(retired, false, "maintenance must finish after its requesting client exits");
    release.resolve();
    const deadline = Date.now() + 4_000;
    while (owner.hasPendingWork && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(owner.hasPendingWork, false);
    await waitForRetirement(retirement.promise, advance);
  } finally {
    release.resolve();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

test("a detached memory owner exits after its only client process ends", { timeout: 50_000 }, async () => {
  const root = await canonicalMemoryRoot(await mkdtemp(path.join(os.tmpdir(), "biny-memory-process-idle-")));
  const child = await client(root);
  try {
    const owner = await discoverMemoryOwner(root, root, false);
    assert.ok(owner);
    assert.notEqual(owner.pid, process.pid);
    await stop(child);
    const deadline = Date.now() + 40_000;
    while (isProcessAlive(owner.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(isProcessAlive(owner.pid), false, "the detached owner process must actually exit");
    assert.equal(await discoverMemoryOwner(root, root, false), undefined);
  } finally {
    await stop(child);
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

test("cancelling one caller waiting for retention does not cancel another caller", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-lease-cancel-"));
  const endpoint = path.join(root, "owner.sock");
  const connected = Promise.withResolvers<ServerResponse>();
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/lease") { connected.resolve(res); return; }
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: "ok" }));
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const registration = { endpoint, hostEpoch: "test", token: "test", pid: process.pid, protocolVersion: 17,
    persistenceRoot: root, registrationPath: "", lockPath: "", rootHash: "test", createdAt: "test" };
  const controller = new AbortController();
  try {
    const cancelled = memoryRequest(registration, "first", {}, controller.signal);
    const rejected = assert.rejects(cancelled, { name: "AbortError" });
    const retained = memoryRequest(registration, "second", {});
    const response = await connected.promise;
    controller.abort();
    await rejected;
    assert.equal(calls, 0);
    response.writeHead(200).flushHeaders();
    assert.equal(await retained, "ok");
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
