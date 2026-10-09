import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry, createToolRegistry } from "../src/tools/registry.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cu-shell-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "shell-boundary");
  context.after(async () => { await recorder.close(); await rm(root, { recursive: true, force: true }); });
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  const registry: ToolRegistry = createToolRegistry({ workspaceRoot: root, ignore: [] }, undefined, undefined, undefined, config.sandbox);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined, () => ({}));
  return { root, recorder, bash: coordinator.createAgentTools().find(tool => tool.name === "Bash")! };
}

test("Agent Bash refuses direct Computer Use CLI even with full access before launching the command", async context => {
  const { root, recorder, bash } = await fixture(context);
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "bin/biny"), "#!/bin/sh\necho bypass > marker\n", { mode: 0o700 });
  const result = await bash.execute("bypass", { command: "./bin/biny cu type --pid 42 test" });
  assert.equal(result.isError, true, "ordinary full-access admission must not authorize a second uncontrolled desktop path");
  assert.match(JSON.stringify(result.details), /computer_shell_bypass_refused/);
  await assert.rejects(readFile(path.join(root, "marker")), /ENOENT/);
  await recorder.close();
  const events = await readFile(recorder.filePath, "utf8");
  assert.match(events, /"type":"tool_result"/);
  assert.match(events, /computer_shell_bypass_refused/);
});

test("macOS Agent Bash cannot reach an existing raw helper socket but keeps ordinary local IPC", { skip: process.platform !== "darwin", timeout: 15_000 }, async context => {
  const { root, bash } = await fixture(context);
  const sockets = [path.join(root, "biny-computer-use-fixture.sock"), path.join(root, "ordinary.sock")];
  const connections = [0, 0];
  for (const [index, socketPath] of sockets.entries()) {
    const server = net.createServer(socket => { connections[index]! += 1; socket.end("ordinary local reply"); });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  }
  const command = (socketPath: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const socket=require('node:net').connect(${JSON.stringify(socketPath)});socket.on('data',data=>process.stdout.write(data));socket.on('error',()=>process.exit(9));`)}`;
  const denied = await bash.execute("raw-socket", { command: command(sockets[0]!) });
  assert.equal(denied.isError, true, "string filtering alone misses commands that connect to a pre-existing native daemon");
  assert.equal(connections[0], 0);
  const ordinary = await bash.execute("ordinary-socket", { command: command(sockets[1]!) });
  assert.equal(ordinary.isError, false, JSON.stringify(ordinary.details));
  assert.match(JSON.stringify(ordinary.details), /ordinary local reply/);
  assert.equal(connections[1], 1);
});
