/**
 * 独立 Runtime Host 进程入口。
 *
 * 这个文件只负责 composition root 和进程信号；协议、owner 选举、生命周期和 runtime
 * 重建都留在 `runtime/host/`，便于 CLI、Desktop 和测试共享同一套边界。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileConfigStore } from "../config/store.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "./InteractiveAgentRuntime.js";
import { WorktreeManager } from "./host/worktree.js";
import {
  findLatestInterruptedSession,
  startRuntimeHost,
  type RuntimeHostServer,
  type RuntimeHostFactory,
  type RuntimeHostFactoryOptions
} from "./RuntimeHost.js";
import type { BrowserAutomationEndpoint } from "../tools/browser.js";

export interface RuntimeHostProcessOptions {
  lifecycleMode: "ephemeral" | "service";
  idleGraceMs: number;
  workspaceRoot: string;
  persistenceRoot: string;
  configDir?: string;
  attachmentRoot?: string;
  sessionId?: string;
  resumeInterrupted: boolean;
}

export async function runRuntimeHostProcess(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  let server: RuntimeHostServer | undefined = undefined;
  let shuttingDown = false;
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  let checkingIdle = false;
  const armShutdownDeadline = (): void => {
    // 期限属于整个独立进程，覆盖资源关闭、日志刷盘卡住等情况；不能提前删 owner 锁。
    shutdownDeadline ??= setTimeout(() => process.exit(1), 10_000);
  };
  const closeOwner = (): void => {
    if (!server) return;
    void server.closeOwner().then(() => process.exit(0), () => process.exit(1));
  };
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    armShutdownDeadline();
    closeOwner();
  };
  const checkIdle = async (): Promise<void> => {
    if (!server || shuttingDown || checkingIdle || options.lifecycleMode === "service") return;
    checkingIdle = true;
    try {
      if (await server.retireIfIdle(options.idleGraceMs)) process.exit(0);
    } catch {
      // 已经开始关闭时由硬期限兜底；空闲证明失败不能被当作可以终止任务的证据。
      if (shutdownDeadline) process.exit(1);
    } finally {
      checkingIdle = false;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (options.lifecycleMode === "ephemeral" && process.channel) {
    process.once("disconnect", () => {
      // 还没 ready 就失去启动者时，给初始化一个有界的收尾机会。
      if (!server) armShutdownDeadline();
      else void checkIdle();
    });
    process.channel.unref();
  }
  const selectedSession = options.sessionId
    ?? (options.resumeInterrupted ? await findLatestInterruptedSession(options.persistenceRoot) : undefined);
  const configStore = createFileConfigStore(options.workspaceRoot, {
    globalDir: options.configDir
  });
  const browserAutomation = browserAutomationFromEnvironment();
  const createRuntime: RuntimeHostFactory = async (sessionId?: string, factoryOptions?: RuntimeHostFactoryOptions): Promise<InteractiveAgentHost> => {
    const fresh = factoryOptions?.fresh === true;
    const host = await createInteractiveAgentHost(factoryOptions?.workspaceRoot ?? options.workspaceRoot, {
      persistenceRoot: options.persistenceRoot,
      configStore,
      attachmentRoot: options.attachmentRoot,
      sessionId: fresh ? sessionId : undefined,
      browserAutomation,
      resourceRegistry: factoryOptions?.resourceRegistry,
      resourceBoot: factoryOptions?.resourceBoot ?? (factoryOptions?.resourceRegistry === undefined ? "blocking" : "background")
    });
    try {
      if (sessionId !== undefined && !fresh) await host.runtime.resumeSession(sessionId);
      return host;
    } catch (error) {
      await host.runtime.close();
      throw error;
    }
  };

  const worktrees = new WorktreeManager(options.workspaceRoot, options.persistenceRoot);
  const initialFactoryOptions = selectedSession === undefined
    ? undefined
    : await worktrees.runtimeFactoryOptions(selectedSession);
  server = await startRuntimeHost(options.persistenceRoot, (resourceRegistry) => createRuntime(selectedSession, {
    ...initialFactoryOptions,
    resourceRegistry,
    resourceBoot: "background"
  }), {
    workspaceRoot: options.workspaceRoot,
    createRuntime,
    resumeInterrupted: options.resumeInterrupted,
    configDir: options.configDir,
    onClosing: armShutdownDeadline
  });
  if (shuttingDown) closeOwner();
  else {
    if (shutdownDeadline) clearTimeout(shutdownDeadline);
    shutdownDeadline = undefined;
    if (options.lifecycleMode === "ephemeral") {
      const interval = setInterval(() => { void checkIdle(); }, Math.min(1_000, Math.max(10, options.idleGraceMs)));
      interval.unref();
      void checkIdle();
    }
  }
  await new Promise<void>(() => undefined);
}

function browserAutomationFromEnvironment(): BrowserAutomationEndpoint | undefined {
  const endpoint = process.env.BINY_BROWSER_CONTROL_ENDPOINT;
  const token = process.env.BINY_BROWSER_CONTROL_TOKEN;
  return endpoint && token ? { endpoint, token } : undefined;
}

function parseOptions(argv: readonly string[]): RuntimeHostProcessOptions {
  const values = new Map<string, string>();
  let resumeInterrupted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--resume-interrupted") {
      resumeInterrupted = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unknown Runtime Host argument: ${argument ?? ""}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Runtime Host argument ${argument} needs a value.`);
    values.set(name, value);
    index += 1;
  }
  const workspaceRoot = requiredOption(values, "workspace-root");
  const persistenceRoot = requiredOption(values, "persistence-root");
  const lifecycleMode = values.get("lifecycle-mode") ?? "ephemeral";
  if (lifecycleMode !== "ephemeral" && lifecycleMode !== "service") throw new Error("Runtime Host lifecycle-mode must be ephemeral or service.");
  const idleGraceMs = Number(values.get("idle-grace-ms") ?? 30_000);
  if (!Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) throw new Error("Runtime Host idle-grace-ms must be a non-negative safe integer.");
  return {
    lifecycleMode,
    idleGraceMs,
    workspaceRoot: path.resolve(workspaceRoot),
    persistenceRoot: path.resolve(persistenceRoot),
    configDir: values.get("config-dir"),
    attachmentRoot: values.get("attachment-root"),
    sessionId: values.get("session-id"),
    resumeInterrupted
  };
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value?.trim()) throw new Error(`Runtime Host requires --${name}.`);
  return value;
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedFile === currentFile) await runRuntimeHostProcess();
