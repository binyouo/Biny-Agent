/**
 * TUI runtime 启动失败不再是终态：提交消息时会重试启动并透出真实原因；
 * owner 恢复后，下一次提交不需要重启 TUI 就能正常进入 runtime。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { saveConfig } from "../src/config/loader.js";
import { defaultConfig } from "../src/config/schema.js";
import { globalAgentDir, globalConfigDir } from "../src/config/paths.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import { BinyTui } from "../src/tui/app.js";
import { readSessionEvents } from "../src/session/events.js";

function createFakeTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined
  };
}

function notifications(app: BinyTui): string[] {
  return app.tuiState.transcript.committed
    .filter((item): item is Extract<typeof item, { kind: "notification" }> => item.kind === "notification")
    .map((item) => item.content);
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-recovery-"));
const workspaceRoot = await realpath(root);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let app: BinyTui | undefined;
try {
  const paths = runtimeHostPaths(workspaceRoot);
  await mkdir(path.dirname(paths.endpoint), { recursive: true });
  // 伪造一个「进程活着但 endpoint 不可用」的 owner：registration 指向测试进程，
  // 但没有 socket 在监听。attach 会快速失败（ECONNREFUSED → owner 存活 → 报错），不会挂起。
  await writeFile(paths.lockPath, `${String(process.pid)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(paths.registrationPath, `${JSON.stringify({
    protocolVersion: runtimeHostProtocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: workspaceRoot,
    configRoot: globalConfigDir(),
    agentRoot: globalAgentDir(),
    hostEpoch: randomUUID(),
    token: "test-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  })}\n`, { encoding: "utf8", mode: 0o600 });

  app = new BinyTui(new TUI(createFakeTerminal()), workspaceRoot);
  const submit = (text: string): Promise<void> => app!["submit"](text);

  // Given runtime 启动失败（owner 存活但 endpoint 不可用），When 提交普通消息，
  // Then 输入保留，通知里透出真实失败原因，而不是只给「检查模型配置后重启」的误导提示。
  const failedSend = submit("第一次发送");
  app["editor"].setText("下一条草稿");
  await failedSend;
  assert.equal(app["editor"].getText(), "第一次发送\n下一条草稿", "启动失败时保留原消息和新草稿");
  const firstRound = notifications(app);
  assert.ok(firstRound.some((content) => content.includes("尚未就绪")), "应提示 runtime 未就绪");
  assert.ok(
    firstRound.some((content) => /endpoint is unavailable|already running/u.test(content)),
    `通知应包含真实原因，实际：${JSON.stringify(firstRound)}`
  );

  // 释放伪造 owner，并在同进程内启动真实 Host：模拟「卡住的 owner 恢复/被替换」。
  // Host 的 runtime 需要一个可用模型配置；local provider 指向不可达端口，只要求启动成功，
  // 提交后的模型调用失败属于错误路径，不影响本测试的恢复语义。
  await unlink(paths.registrationPath);
  await unlink(paths.lockPath);
  await saveConfig(workspaceRoot, {
    ...structuredClone(defaultConfig),
    defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  }, { globalDir: globalConfigDir() });
  const configStore = createFileConfigStore(workspaceRoot, { globalDir: globalConfigDir() });
  let rejectDraft = true;
  host = await startRuntimeHost(workspaceRoot, (resourceRegistry) => createInteractiveAgentHost(workspaceRoot, {
    persistenceRoot: workspaceRoot,
    configStore,
    resourceRegistry,
    resourceBoot: "background"
  }), {
    workspaceRoot,
    createRuntime: async (sessionId, options) => {
      if (options?.fresh && rejectDraft) {
        rejectDraft = false;
        throw new Error("New session initialization failed.");
      }
      return await createInteractiveAgentHost(workspaceRoot, {
        persistenceRoot: workspaceRoot, configStore, sessionId,
        resourceRegistry: options?.resourceRegistry, resourceBoot: "background"
      });
    },
    configDir: globalConfigDir(),
    resumeInterrupted: false
  });

  await submit("初始化失败时不应误发");
  assert.ok(notifications(app).some(content => content.includes("尚未就绪") && content.includes("New session initialization failed")));
  assert.equal(app.tuiState.sessionId, "");
  const primaryEvents = await readSessionEvents(host.getCurrentRuntime().getSnapshot().info.sessionFile);
  assert.equal(primaryEvents.some(event => event.type === "user_message"), false, "failed initialization must not submit to the existing primary session");

  // When 再次提交（不重启 TUI），Then runtime 重试启动成功，消息进入正常提交流程：
  // session.started 生效（sessionId 非空），且不再新增「尚未就绪」通知。
  const stuckCount = notifications(app).filter((content) => content.includes("尚未就绪")).length;
  void submit("第二次发送");
  const deadline = Date.now() + 10_000;
  while (app.tuiState.sessionId === "" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.notEqual(app.tuiState.sessionId, "", "重试后 runtime 应就绪并派发 session.started");
  const stillStuck = notifications(app).filter((content) => content.includes("尚未就绪")).length;
  assert.equal(stillStuck, stuckCount, "恢复后不应再出现「尚未就绪」通知");
} finally {
  // 先关 TUI 的 client 再关 Host：Host 先关会触发 client 的重连级联（甚至 respawn），
  // 让测试进程无法退出。
  await app?.exit();
  await host?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}
console.log("tui runtime recovery tests passed");
