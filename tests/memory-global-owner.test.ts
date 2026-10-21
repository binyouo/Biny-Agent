import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { AgentMemoryClient } from "../src/runtime/memory/client.js";
import { canonicalMemoryRoot, discoverMemoryOwner, serveMemoryOwner } from "../src/runtime/memory/transport.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { LocalEmbeddingModelId, LocalEmbeddingModelStatus } from "../src/llm/embedding/types.js";

class ControlledModels extends LocalEmbeddingManager {
  readonly entered = Promise.withResolvers<void>();
  readonly settled = Promise.withResolvers<void>();
  downloads = 0;
  disposed = false;
  override async list(): Promise<LocalEmbeddingModelStatus[]> { return []; }
  override async download(model: LocalEmbeddingModelId, options: Parameters<LocalEmbeddingManager["download"]>[1] = {}): Promise<LocalEmbeddingModelStatus> {
    this.downloads++;
    options.onProgress?.({ model, status: "downloading", progress: 0.5 });
    this.entered.resolve();
    try {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
      throw new Error("Expected cancellation");
    } finally { this.settled.resolve(); }
  }
  override async close(): Promise<void> { this.disposed = true; }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-memory-owner-"));
  const root = await canonicalMemoryRoot(directory);
  const config = structuredClone(defaultConfig);
  config.context.memory.sleepEnabled = false;
  const local = new ControlledModels(path.join(root, "models"));
  const owner = new AgentMemoryOwner(root, { load: async () => config, save: async () => { throw new Error("Unexpected config write"); } }, local);
  const server = await serveMemoryOwner(root, root, owner);
  return { root, local, owner, client: () => new AgentMemoryClient(root, root), close: async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test("workspace clients share global progress, admission and cancellation through one owner", { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.client();
    const second = f.client();
    const downloading = first.download("multilingual-e5-small");
    const rejected = assert.rejects(downloading, /cancelled/i);
    await f.local.entered.promise;
    const sessionMemory = new LocalMemory(f.root, () => { throw new Error("No model call expected"); }, undefined, 3, undefined, undefined, undefined, undefined, { agentDir: f.root });
    try { await sessionMemory.writeEntry({ content: "Session lifetime does not own global maintenance." }); }
    finally { sessionMemory.close(); }
    assert.equal(f.local.disposed, false);
    const status = await second.status();
    assert.equal(status.operation?.state, "running");
    assert.equal(status.operation?.kind, "download");
    if (status.operation?.kind === "download") assert.equal(status.operation.progress?.progress, 0.5);
    await assert.rejects(second.rebuild(), /正在进行/);
    assert.equal(f.local.downloads, 1);
    assert.equal(await second.cancelDownload("multilingual-e5-small"), true);
    await rejected;
    await f.local.settled.promise;
    assert.equal((await second.status()).operation?.state, "cancelled");
    assert.equal(await first.cancelDownload("multilingual-e5-small"), false);
  } finally { await f.close(); }
  assert.equal(f.local.disposed, true);
});

test("canonical roots share an owner and different roots isolate operations", { timeout: 10_000 }, async () => {
  const first = await fixture();
  const second = await fixture();
  const link = `${first.root}-alias`;
  try {
    await symlink(first.root, link);
    const original = await discoverMemoryOwner(first.root, first.root, false);
    const alias = await discoverMemoryOwner(link, first.root, false);
    assert.equal(alias?.hostEpoch, original?.hostEpoch);
    const work = first.client().download("multilingual-e5-small");
    const rejected = assert.rejects(work, /cancelled/i);
    await first.local.entered.promise;
    assert.equal((await second.client().status()).operation, undefined);
    assert.equal(await second.client().cancelDownload("multilingual-e5-small"), false);
    await first.client().cancelDownload("multilingual-e5-small");
    await rejected;
  } finally {
    await rm(link, { force: true });
    await first.close();
    await second.close();
  }
});

test("closing owner cancels and drains work before releasing resources", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const work = f.client().download("multilingual-e5-small");
  const rejected = assert.rejects(work);
  await f.local.entered.promise;
  await f.close();
  await rejected;
  await f.local.settled.promise;
  assert.equal(f.local.disposed, true);
});

test("independent clients discover one detached owner that outlives the requesting process", { timeout: 25_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-memory-owner-process-"));
  const root = await canonicalMemoryRoot(directory);
  let pid: number | undefined;
  try {
    const modulePath = new URL("../src/runtime/memory/client.ts", import.meta.url).href;
    const script = `import { AgentMemoryClient } from ${JSON.stringify(modulePath)}; await new AgentMemoryClient(process.env.BINY_AGENT_DIR, process.env.BINY_AGENT_DIR).sleepStatus();`;
    const runClient = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, BINY_AGENT_DIR: root }, stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `client exited ${code}`)));
    });
    await Promise.all([runClient(), runClient()]);
    const registration = await discoverMemoryOwner(root, root, false);
    assert.ok(registration);
    pid = registration.pid;
    assert.notEqual(pid, process.pid);
    const client = new AgentMemoryClient(root, root);
    assert.ok(await client.sleepStatus());
    assert.equal((await discoverMemoryOwner(root, root, false))?.hostEpoch, registration.hostEpoch);
  } finally {
    const registration = await discoverMemoryOwner(root, root, false);
    pid ??= registration?.pid;
    if (pid) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 12_000;
      while (await discoverMemoryOwner(root, root, false)) {
        if (Date.now() > deadline) {
          process.kill(pid, "SIGKILL");
          assert.fail("Memory owner did not drain on shutdown");
        }
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
