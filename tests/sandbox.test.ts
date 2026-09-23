import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSeatbeltProfile, describeSandbox, sandboxCommand } from "../src/tools/shell/sandbox.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { parseSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  testOffAndUnsupportedPlatformsAreHonest();
  testProfileShape();
  await testRealBoundaryOnMacOs();
  await testDeniedPaths();
  await testRuntimeBoundary();
  console.log("sandbox tests passed");
}

/** 从公开工具入口执行到真实子进程和持久化事件，审批放行不能取消路径禁令。 */
async function testRuntimeBoundary(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-sandbox-runtime-"));
  const config = structuredClone(defaultConfig);
  // 刻意让运行时 config 与权限权威不同，防止 Bash 偷用默认配置而丢掉用户策略。
  config.permission.denyPaths = [];
  const manager = new PermissionManager({ mode: "full-access", denyPaths: ["secrets/"] });
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "sandbox-runtime");
  const processes = new ManagedProcessService({ workspaceRoot: root });
  try {
    await mkdir(path.join(root, "secrets"));
    await writeFile(path.join(root, "secrets/token"), "PRIVATE_SENTINEL");
    const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...config.webSearch, enabled: false }, processes, config.webFetch, config.sandbox);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, manager, () => {}, () => ({}));
    const bash = coordinator.createAgentTools().find((tool) => tool.name === "Bash")!;
    recorder.record({ type: "user_message", content: "Exercise command path restrictions." });
    const denied = await bash.execute("denied", { command: "cat secrets/token" });
    const details = denied.details as { exitCode?: number; error?: string; stdout?: string };
    if (process.platform === "darwin") {
      assert.equal(typeof details.exitCode, "number", JSON.stringify(denied));
      assert.notEqual(details.exitCode, 0);
      assert.equal(JSON.stringify(denied).includes("PRIVATE_SENTINEL"), false);
      const allowed = await bash.execute("allowed", { command: "echo ordinary > ordinary.txt; cat ordinary.txt" });
      assert.equal((allowed.details as { exitCode: number }).exitCode, 0, JSON.stringify(allowed));
      assert.equal((await readFile(path.join(root, "ordinary.txt"), "utf8")).trim(), "ordinary");
      const background = await bash.execute("background", {
        command: "cat secrets/token; echo BOUNDARY_CHECKED; exec tail -f /dev/null",
        background: true,
        readiness: { type: "log", pattern: "BOUNDARY_CHECKED", timeoutMs: 5_000, intervalMs: 10 }
      });
      const processId = (background.details as { process: { processId: string } }).process.processId;
      const output = await processes.readOutput(processId);
      assert.match(output.content, /Operation not permitted/);
      assert.equal(output.content.includes("PRIVATE_SENTINEL"), false);
      await processes.stop(processId);
    } else {
      assert.match(details.error ?? "", /Cannot enforce command sandbox restrictions/);
    }
    recorder.record({ type: "assistant_message", content: "Boundary checked." });
    await coordinator.waitForIdle();
    await recorder.close();
    const raw = await readFile(recorder.filePath, "utf8");
    assert.equal(raw.includes("PRIVATE_SENTINEL"), false);
    const events = parseSessionEvents(raw);
    for (const type of ["user_message", "assistant_message", "tool_call", "tool_result", "error"]) {
      assert.ok(events.some((event) => event.type === type), `missing stable event: ${type}`);
    }
    assert.equal(await readFile(path.join(root, "secrets/token"), "utf8"), "PRIVATE_SENTINEL");
  } finally {
    await processes.close();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Given 可读的依赖和敏感文件，When 命令间接读取或改写，Then 内核拒绝敏感路径且普通命令仍可运行。 */
async function testDeniedPaths(): Promise<void> {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-denied-paths-"));
  try {
    await mkdir(path.join(root, "nested"));
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".ssh/key"), "SSH_SENTINEL");
    await writeFile(path.join(root, "nested/.env.local"), "SECRET_SENTINEL");
    await writeFile(path.join(root, "node_modules/ordinary.txt"), "ordinary");
    await symlink(path.join(root, "nested/.env.local"), path.join(root, "alias"));
    const options = { mode: "off" as const, allowNetwork: true, denyPaths: [".env", ".ssh/"] };
    const environment = { platform: process.platform, home: os.homedir(), temporaryDirectory: os.tmpdir() };
    const run = (command: string) => runShellCommand(root, sandboxCommand(command, root, options, environment).command, { timeoutMs: 10_000 });
    assert.equal((await run("cat node_modules/ordinary.txt")).stdout, "ordinary");
    assert.notEqual((await run("cat .ssh/key")).exitCode, 0);
    assert.notEqual((await run("echo new > nested/.env.new")).exitCode, 0);
    for (const command of ["cat nested/.env.local", "cat alias", "sh -c 'p=nested/.env.local; cat \"$p\"'", "echo changed > nested/.env.local", "mv nested/.env.local stolen", "ln nested/.env.local stolen"]) {
      const result = await run(command);
      assert.notEqual(result.exitCode, 0, command);
      assert.equal(result.stdout.includes("SECRET_SENTINEL"), false, command);
      assert.equal(await readFile(path.join(root, "nested/.env.local"), "utf8"), "SECRET_SENTINEL");
    }
    // 显式路径按字面量而非正则解释；在工作区可写时，拒绝仍必须优先。
    const unusual = 'nested/key.[x](a)+"quote';
    await writeFile(path.join(root, unusual), "QUOTED_SENTINEL");
    await symlink(path.join(root, unusual), path.join(root, "key-alias"));
    for (const rule of [unusual, path.join(root, unusual)]) {
      const restricted = { mode: "workspace-write" as const, allowNetwork: true, denyPaths: [rule] };
      for (const command of ["cat key-alias", "echo changed > key-alias", "mv nested renamed"]) {
        const result = await runShellCommand(root, sandboxCommand(command, root, restricted, environment).command);
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, /Operation not permitted/, "a malformed sandbox profile is not proof of path enforcement");
      }
      assert.equal(await readFile(path.join(root, unusual), "utf8"), "QUOTED_SENTINEL");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 沙箱没生效时必须说出来，不能让"沙箱模式"这个名字暗示一个不存在的保护。 */
function testOffAndUnsupportedPlatformsAreHonest(): void {
  const environment = { platform: "darwin" as NodeJS.Platform, home: "/Users/x", temporaryDirectory: "/tmp" };
  const off = sandboxCommand("echo hi", "/ws", { mode: "off", allowNetwork: true }, environment);
  assert.equal(off.applied, false);
  assert.equal(off.command, "echo hi");
  assert.equal(typeof off.reason, "string");

  assert.throws(() => sandboxCommand("echo hi", "/ws", { mode: "workspace-write", allowNetwork: true }, { ...environment, platform: "linux" }), /Cannot enforce.*linux/);
  assert.throws(() => sandboxCommand("echo hi", "/ws", { mode: "off", allowNetwork: true, denyPaths: [".env"] }, { ...environment, platform: "linux" }), /Cannot enforce.*linux/);
  assert.equal(describeSandbox({ mode: "workspace-write", allowNetwork: true }, "linux"), "requested but unavailable on linux");
  assert.equal(describeSandbox({ mode: "workspace-write", allowNetwork: false }, "darwin"), "workspace-write, no network");
}

function testProfileShape(): void {
  const profile = buildSeatbeltProfile("/ws", { mode: "workspace-write", allowNetwork: false }, { home: "/Users/x", temporaryDirectory: "/tmp" });
  assert.equal(profile.includes("(deny file-write*)"), true);
  assert.equal(profile.includes('(subpath "/ws")'), true);
  assert.equal(profile.includes("(deny network*)"), true);
  const networked = buildSeatbeltProfile("/ws", { mode: "workspace-write", allowNetwork: true }, { home: "/Users/x", temporaryDirectory: "/tmp" });
  assert.equal(networked.includes("(deny network*)"), false);
}

/**
 * 真正跑一次。前面那些断言只证明字符串拼对了，证明不了内核真的挡住了写入 —— 而这正是这
 * 个功能唯一的价值所在。
 */
async function testRealBoundaryOnMacOs(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("sandbox boundary check skipped: not macOS");
    return;
  }
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sandbox-ws-"));
  // 必须建在临时目录之外：临时目录本身在白名单里（构建工具需要），拿它当"外部"验证不到东西。
  const outside = await mkdtemp(path.join(os.homedir(), ".biny-sandbox-outside-"));
  try {
    await writeFile(path.join(outside, "victim.txt"), "original\n");
    const options = { mode: "workspace-write" as const, allowNetwork: true };
    const environment = { platform: process.platform, home: os.homedir(), temporaryDirectory: os.tmpdir() };

    const allowed = sandboxCommand("echo written > inside.txt", workspaceRoot, options, environment);
    assert.equal(allowed.applied, true);
    const allowedRun = await runShellCommand(workspaceRoot, allowed.command, { timeoutMs: 30_000 });
    assert.equal(allowedRun.exitCode, 0, `writing inside the workspace must work: ${allowedRun.stderr}`);
    assert.equal((await readFile(path.join(workspaceRoot, "inside.txt"), "utf8")).trim(), "written");

    // 关键断言：工作区之外的写入必须被内核拒绝，而不是被某条正则拦下。
    const victim = path.join(outside, "victim.txt");
    const denied = sandboxCommand(`echo pwned > ${JSON.stringify(victim)}`, workspaceRoot, options, environment);
    const deniedRun = await runShellCommand(workspaceRoot, denied.command, { timeoutMs: 30_000 });
    assert.notEqual(deniedRun.exitCode, 0, "writing outside the workspace must fail");
    assert.equal(await readFile(victim, "utf8"), "original\n", "the file outside the workspace must be untouched");

    // 判定绕过也一样挡住：这正是正则做不到的部分。
    const obfuscated = sandboxCommand(
      `sh -c "$(echo 'ZWNobyBwd25lZCA+ICcnJHtWSUNUSU19JycK' | base64 --decode)"`,
      workspaceRoot,
      options,
      { ...environment }
    );
    const obfuscatedRun = await runShellCommand(workspaceRoot, obfuscated.command, {
      timeoutMs: 30_000
    });
    assert.equal(await readFile(victim, "utf8"), "original\n", `an obfuscated write must also be blocked (exit ${String(obfuscatedRun.exitCode)})`);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

await main();
