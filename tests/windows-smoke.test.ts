import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { connectRuntimeHost, spawnRuntimeHost } from "../src/runtime/host/connection.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { acquireHostLock, ensureRuntimeHostDirectory, isProcessAlive, readRegistration, removeStaleRegistration, runtimeHostPaths, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import { defaultShell } from "../src/tools/shell/shell.js";
import { redactSecrets } from "../src/utils/redaction.js";

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "platform smoke did not reach the expected process state");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function nodeCommand(script: string): string {
  const shell = defaultShell();
  if (shell.kind === "cmd") return `"${process.execPath}" "${script}"`;
  const quoted = [process.execPath, script].map((value) => `'${value.replaceAll("'", shell.kind === "posix" ? "'\\''" : "''")}'`).join(" ");
  return shell.kind === "posix" ? quoted : `& ${quoted}`;
}

test("Desktop and TUI connect to one real Host, authenticate, retire, and restart", { timeout: 180_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "biny windows 中文 ")));
  const configDir = path.join(root, "config");
  await saveConfig(root, {
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    activity: { ...defaultConfig.activity, enabled: false },
    computer: { ...defaultConfig.computer, enabled: false }
  }, { globalDir: configDir });
  let launched: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
  let tui: Awaited<ReturnType<typeof connectRuntimeHost>>;
  const paths = runtimeHostPaths(root);
  let phase = "initial Desktop spawn";
  try {
    // Match discovery startup: finish directory security before the short idle window starts.
    await ensureRuntimeHostDirectory(path.dirname(paths.registrationPath));
    launched = await spawnRuntimeHost(root, { workspaceRoot: root, configDir, clientId: "desktop-smoke", surface: "desktop", idleGraceMs: 250 });
    const registration = await readRegistration(paths);
    assert.ok(registration);
    assert.equal(registration.pid, launched.process.pid);
    phase = "TUI attach";
    tui = await connectRuntimeHost(root, { configDir, clientId: "tui-smoke", surface: "tui" });
    phase = "connected-client authentication and retirement";
    assert.ok(tui, "TUI must attach to the owner elected by Desktop");
    assert.equal(tui.getSnapshot().info.sessionId, launched.client.getSnapshot().info.sessionId);
    assert.equal((await tui.getHostStatus()).hostEpoch, registration.hostEpoch);
    await assert.rejects(acquireHostLock(paths, root), /already running or starting/u);
    await assert.rejects(RuntimeHostClient.connect({ registration: { ...registration, token: "wrong-platform-smoke-token" }, configDir, clientId: "invalid-smoke", handshakeTimeoutMs: 2_000 }));
    await launched.client.close();
    assert.equal(isProcessAlive(registration.pid), true);
    assert.equal((await tui.getHostStatus()).hostEpoch, registration.hostEpoch, "closing the Desktop client must preserve the TUI connection");
    await tui.close(); tui = undefined;
    await until(() => launched!.process.exitCode !== null || launched!.process.signalCode !== null);
    assert.equal(launched.process.exitCode, 0);
    await assert.rejects(access(paths.registrationPath), { code: "ENOENT" });
    await assert.rejects(access(paths.lockPath), { code: "ENOENT" });
    phase = "restarted Host spawn";
    launched = await spawnRuntimeHost(root, { workspaceRoot: root, configDir, clientId: "restarted-smoke", surface: "tui", idleGraceMs: 250 });
    phase = "restarted Host retirement";
    assert.notEqual((await launched.client.getHostStatus()).hostEpoch, registration.hostEpoch);
    await launched.client.close();
    await until(() => launched!.process.exitCode !== null || launched!.process.signalCode !== null);
    assert.equal(launched.process.exitCode, 0);
  } catch (error) {
    // Report only selected public process fields, never registration or configuration.
    throw new Error(`Windows Host smoke failed: ${JSON.stringify({
      phase,
      lastCompletedSpawn: launched === undefined ? undefined : {
        pid: launched.process.pid,
        exitCode: launched.process.exitCode,
        signalCode: launched.process.signalCode
      },
      cause: {
        name: error instanceof Error ? redactSecrets(error.name).slice(0, 100) : "UnknownError",
        message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      }
    })}`);
  } finally {
    await tui?.close();
    await launched?.client.close();
    if (launched) await terminateSpawnedHost(launched.process);
    const stale = await readRegistration(paths);
    if (stale && !isProcessAlive(stale.pid)) await removeStaleRegistration(stale);
    await rm(root, { recursive: true, force: true });
  }
});

test("native shell preserves Unicode and exit codes, and cleans background and timed-out process trees", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "biny shell 中文 ")));
  const service = new ManagedProcessService({ workspaceRoot: root, terminationGraceMs: 500, killSettleMs: 3_000 });
  const descendants = new Set<number>();
  const pidFile = path.join(root, "descendant.json");
  try {
    const outputScript = path.join(root, "output.cjs");
    await writeFile(outputScript, "process.stdout.write('中文输出'); process.exit(42);");
    const output = await runShellCommand(root, nodeCommand(outputScript));
    assert.equal(output.stdout, "中文输出");
    assert.equal(output.exitCode, 42);
    if (process.platform === "win32") {
      const cmdOutput = await runShellCommand(root, `"${process.execPath}" "${outputScript}"`, {
        shell: { kind: "cmd", executable: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe" }
      });
      assert.equal(cmdOutput.stdout, "中文输出");
      assert.equal(cmdOutput.exitCode, 42);
    }

    const treeScript = path.join(root, "tree.cjs");
    await writeFile(treeScript, `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(child.pid));
      console.log('READY 中文');
      setInterval(() => {}, 1000);
    `);
    const background = await service.start({ command: nodeCommand(treeScript), readiness: { type: "log", pattern: "READY 中文", timeoutMs: 8_000 } });
    assert.equal(background.readiness?.passed, true);
    const pid = JSON.parse(await readFile(pidFile, "utf8")) as number;
    descendants.add(pid);
    assert.equal(isProcessAlive(pid), true);
    const stopped = await service.stop(background.processId);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.cleanup.status, "stopped");
    await until(() => !isProcessAlive(pid));
    await rm(pidFile);
    const timed = await runShellCommand(root, nodeCommand(treeScript), {
      timeoutMs: 8_000, terminationGraceMs: 500, killSettleMs: 3_000
    });
    const timedPid = JSON.parse(await readFile(pidFile, "utf8")) as number;
    descendants.add(timedPid);
    assert.equal(timed.status, "timed_out");
    assert.ok(timedPid, "the timed-out command must have started its descendant");
    await until(() => !isProcessAlive(timedPid));
  } finally {
    await service.close();
    const raw = await readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (raw !== undefined) descendants.add(JSON.parse(raw) as number);
    for (const pid of descendants) {
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
      await until(() => !isProcessAlive(pid));
    }
    await rm(root, { recursive: true, force: true });
  }
});
