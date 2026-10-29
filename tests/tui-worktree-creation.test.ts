import { readyHostClient } from "./helpers/readyHostClient.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { createRuntimeHostFactory } from "../src/runtime/host/runtimeFactory.js";
import { BinyTui } from "../src/tui/app.js";

test("/new --isolated creates a worktree through the Host and /new returns to a shared checkout", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-worktree-"));
  const resources: { server?: Awaited<ReturnType<typeof startRuntimeHost>>; client?: Awaited<ReturnType<typeof connectRuntimeHost>>; tui?: TUI } = {};
  t.after(async () => {
    resources.tui?.stop();
    try { await resources.client?.close(); }
    finally {
      try { await resources.server?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "fixture",
    providers: { fixture: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { fixture: { provider: "fixture", model: "fixture" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }, computer: { ...defaultConfig.computer, enabled: false }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Worktree creation must not call a model."); });
  const git = async (args: string[]) => promisify(execFile)("git", args, { cwd: root });
  await git(["init", "--quiet", "-b", "main"]);
  await git(["-c", "user.name=Biny Tests", "-c", "user.email=biny-tests@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const host = await createInteractiveAgentHost(root, { configStore });
  const server = await startRuntimeHost(root, async () => host, { createRuntime: createRuntimeHostFactory(root, () => ({ configStore })) });
  resources.server = server;
  server["businessComposition"].stop();
  const client = await readyHostClient(await connectRuntimeHost(root, { surface: "tui" }));

  resources.client = client;
  assert.ok(client);
  const terminal: Terminal = {
    start: () => undefined, stop: () => undefined, drainInput: async () => undefined, write: () => undefined,
    columns: 80, rows: 24, kittyProtocolActive: false, moveBy: () => undefined, hideCursor: () => undefined,
    showCursor: () => undefined, clearLine: () => undefined, clearFromCursor: () => undefined,
    clearScreen: () => undefined, setTitle: () => undefined, setProgress: () => undefined
  };
  const tui = new TUI(terminal);
  resources.tui = tui;
  const app = new BinyTui(tui, root);
  app["runtime"] = client;
  app["runtimeSnapshot"] = client.getSnapshot();
  await app["handleSlashCommand"]("/new --isolated");
  const isolated = client.getSnapshot().info;
  const worktrees = await client.worktreeList();
  assert.equal(worktrees.length, 1);
  assert.equal(isolated.sessionId, worktrees[0]!.sessionId);
  assert.equal(isolated.workspaceRoot, worktrees[0]!.worktreePath);
  await app["handleSlashCommand"]("/new --unknown");
  assert.equal(client.getSnapshot().info.sessionId, isolated.sessionId, "invalid options cannot create a shared session");
  await app["handleSlashCommand"]("/new");
  assert.equal(client.getSnapshot().info.workspaceRoot, root);
  assert.notEqual(client.getSnapshot().info.sessionId, isolated.sessionId);
  assert.equal((await client.worktreeList()).length, 1);
});
