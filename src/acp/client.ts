import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError, type ClientConnection, type McpServer, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionNotification, type SessionConfigOption, type ContentBlock } from "@agentclientprotocol/sdk";
import { redactSecrets } from "../utils/secrets.js";
import type { AcpConfig, AgentConfig } from "../config/schema.js";

export interface AcpSessionInfo {
  sessionId: string;
  models: Array<{ id: string; name: string }>;
  modes: Array<{ id: string; name: string }>;
  currentModel?: string;
  currentMode?: string;
  modelConfigId?: string;
  modeConfigId?: string;
}

export interface AcpSessionBinding { version: 1; fingerprint: string; sessionId: string }

export function acpMcpServers(config: AgentConfig, launch: AcpConfig, mode = config.permission.mode): McpServer[] {
  if (launch.mcpServers.length && mode !== "full-access") throw new Error("直接转交 MCP 需要完全访问模式；当前权限下请移除 ACP 连接中的 MCP 服务。");
  return launch.mcpServers.map((name): McpServer => {
    const server = config.extensions.mcp[name];
    if (!server || !server.enabled) throw new Error(`ACP MCP 服务 ${name} 不存在或已停用。`);
    if (server.exposure === "hidden" || Object.values(server.toolExposure ?? {}).includes("hidden")) {
      throw new Error(`ACP 无法执行 MCP 服务 ${name} 的隐藏工具策略，请使用独立的受限服务。`);
    }
    if (Object.keys(server.toolContracts ?? {}).length) throw new Error(`ACP 无法执行 MCP 服务 ${name} 的文件变更校验，请使用独立的受限服务。`);
    if (server.oauth) throw new Error(`ACP 暂不转发 MCP 服务 ${name} 的 Biny OAuth 登录，请在外部 Agent 中配置。`);
    if (server.credentialRefs && (Object.keys(server.credentialRefs.env ?? {}).length || Object.keys(server.credentialRefs.headers ?? {}).length)) {
      throw new Error(`ACP MCP 服务 ${name} 使用安全存储凭据，请先配置可供外部 Agent 使用的独立连接。`);
    }
    if (server.url) {
      if (server.transportProtocol === "sse") throw new Error(`ACP MCP 服务 ${name} 暂不支持 SSE。`);
      return { type: "http", name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) };
    }
    if (!server.command) throw new Error(`ACP MCP 服务 ${name} 缺少启动命令。`);
    if (server.cwd) throw new Error(`ACP MCP 服务 ${name} 指定了独立工作目录，无法通过标准 ACP 传递。`);
    return { name, command: server.command, args: server.args, env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) };
  });
}

/** 一个实例只拥有一个项目中的一个外部会话，不共享进程或自动重放请求。 */
export class AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private info?: AcpSessionInfo;
  private busy = false;
  private turnGeneration = 0;
  private fingerprint?: string;
  private stderr = "";
  private stderrOverflow = false;
  private outputBytes = 0;
  private redactions: string[] = [];
  private onUpdate?: (notification: SessionNotification) => void;
  private onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  private turnSignal?: AbortSignal;

  constructor(private readonly options: {
    launch: AcpConfig;
    cwd: string;
    mcpServers?: McpServer[];
    bindingFile?: string;
    requireBinding?: boolean;
    timeoutMs?: number;
  }) {}

  async connect(signal?: AbortSignal): Promise<AcpSessionInfo> {
    const { launch, cwd } = this.options;
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
      "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    for (const [name, source] of Object.entries(launch.env)) {
      if (process.env[source] === undefined) throw new Error(`ACP 环境变量 ${source} 未设置。`);
      env[name] = process.env[source];
    }
    // Electron 主进程不能把启动模式或调试注入传给外部运行时。
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const mcpServers = this.options.mcpServers ?? [];
    const identityEnvironment = Object.fromEntries([...new Set(["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PATH", ...Object.keys(launch.env)])]
      .sort().map((name) => [name, env[name]]));
    const fingerprint = createHash("sha256").update(JSON.stringify({ launch: { ...launch, modeId: undefined, allowMemory: undefined, promptTimeoutMs: undefined, maxOutputBytes: undefined }, cwd, mcpServers, identityEnvironment })).digest("hex");
    if (this.info && this.connection && !this.connection.signal.aborted && this.fingerprint === fingerprint) return this.info;
    await this.close();
    const stored = await this.readBinding();
    signal?.throwIfAborted();
    if (!stored && this.options.requireBinding) throw new Error("ACP 会话关联文件缺失，请新建会话；旧任务未重放。");
    if (stored && stored.fingerprint !== fingerprint) throw new Error("ACP 连接配置已变化，请新建会话，避免将旧会话关联到其他 Agent。");
    this.outputBytes = 0;

    const child = spawn(launch.command, launch.args, { cwd, env, stdio: "pipe", shell: false, detached: process.platform !== "win32", windowsHide: true });
    this.child = child;
    this.stderr = "";
    this.stderrOverflow = false;
    this.redactions = [...Object.values(launch.env).map((source) => process.env[source]),
      ...mcpServers.flatMap((server) => "env" in server ? server.env.map((entry) => entry.value) : "headers" in server ? server.headers.map((entry) => entry.value) : [])]
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.stderrOverflow) return;
      const text = this.stderr + chunk;
      this.stderrOverflow = Buffer.byteLength(text, "utf8") > 8192;
      this.stderr = this.stderrOverflow ? "ACP 错误输出超过上限，已省略。" : text;
    });
    const stdout = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        this.outputBytes += chunk.byteLength;
        if (this.outputBytes > launch.maxOutputBytes) {
          const error = new Error("ACP 输出超过上限，连接已停止；未自动重放任务。");
          connection.close(error);
          controller.error(error);
          void this.close();
          return;
        }
        controller.enqueue(chunk);
      }
    }));
    const connection = client({ name: "biny" })
      .onNotification("session/update", ({ params }) => {
        // Cancellation revokes permission, but final updates can precede the cancelled response.
        if (this.connection === connection && params.sessionId === this.info?.sessionId) {
          if (params.update.sessionUpdate === "config_option_update") this.info = { ...this.info, ...configInfo(params.update.configOptions) };
          this.onUpdate?.(params);
        }
      })
      .onRequest("session/request_permission", async ({ params }) => {
        if (params.sessionId !== this.info?.sessionId || this.turnSignal?.aborted || !this.onPermission) return { outcome: { outcome: "cancelled" } };
        const handler = this.onPermission;
        const generation = this.turnGeneration;
        const response = await handler(params);
        if (generation !== this.turnGeneration || this.connection !== connection || this.turnSignal?.aborted) return { outcome: { outcome: "cancelled" } };
        return response;
      })
      .connect(ndJsonStream(Writable.toWeb(child.stdin), stdout, { maxMessageBytes: 1_048_576 }));
    this.connection = connection;
    child.on("error", (error: NodeJS.ErrnoException) => connection.close(new Error(error.code === "ENOENT"
      ? "找不到 ACP 程序或运行环境。请先安装适配器和 Node.js；已安装时，请在高级设置中填写程序的绝对路径，并确认 Node.js 在 Biny 的 PATH 中。"
      : "ACP 启动失败，请检查命令和执行权限。")));
    child.on("exit", (code, exitSignal) => {
      let failure = new Error(`ACP 进程已退出 (${String(code ?? exitSignal)})。`);
      // close() owns its own exit cleanup after clearing this.child. A spontaneous
      // exit still owns this group: finish it now, never from a later close().
      if (this.child === child && process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          const errorCode = (error as NodeJS.ErrnoException).code;
          if (errorCode !== "ESRCH") {
            failure = new Error(`${failure.message} ACP 进程组清理失败 (${errorCode ?? "unknown"})。`, { cause: error });
          }
        }
      }
      connection.close(failure);
    });
    const startupSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]);
    const stop = (): void => connection.close(startupSignal.reason);
    startupSignal.addEventListener("abort", stop, { once: true });
    try {
      const initialized = await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {} });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error(`ACP 协议版本不支持：${initialized.protocolVersion}`);
      if (launch.authMethodId) await connection.agent.request("authenticate", { methodId: launch.authMethodId });
      if (mcpServers.some((server) => "type" in server && server.type === "http") && !initialized.agentCapabilities?.mcpCapabilities?.http) {
        throw new Error("该 ACP Agent 不支持 HTTP MCP 服务。");
      }
      let response: unknown;
      let sessionId: string;
      if (stored) {
        if (!initialized.agentCapabilities?.loadSession) throw new Error("该 Agent 不支持恢复已有 ACP 会话，请新建会话；旧任务未重放。");
        response = await connection.agent.request("session/load", { sessionId: stored.sessionId, cwd, mcpServers });
        sessionId = stored.sessionId;
      } else {
        const created = await connection.agent.request("session/new", { cwd, mcpServers });
        response = created;
        sessionId = created.sessionId;
        await this.writeBinding({ version: 1, fingerprint, sessionId });
      }
      this.fingerprint = fingerprint;
      this.info = sessionInfo(sessionId, response);
      if (launch.modeId) {
        if (!this.info.modes.some((mode) => mode.id === launch.modeId)) throw new Error(`ACP 模式不可用：${launch.modeId}`);
        if (this.info.modeConfigId) {
          const changed = await connection.agent.request("session/set_config_option", { sessionId, configId: this.info.modeConfigId, value: launch.modeId });
          this.info = { ...this.info, ...configInfo(changed.configOptions) };
        } else await connection.agent.request("session/set_mode", { sessionId, modeId: launch.modeId });
        this.info.currentMode = launch.modeId;
      }
      return this.info;
    } catch (error) {
      const detail = this.safeError(error instanceof RequestError && error.code === RequestError.authRequired().code
        ? new Error("外部 Agent 尚未登录或登录已失效。请在终端完成该 Agent 的登录，再重新连接。")
        : error);
      await this.close();
      throw detail;
    }
    finally { startupSignal.removeEventListener("abort", stop); }
  }

  async prompt(input: { content: ContentBlock[]; model: string; signal?: AbortSignal;
    onUpdate(notification: SessionNotification): void;
    onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> }): Promise<string> {
    if (this.busy) throw new Error("ACP 会话已有运行中的请求。");
    this.busy = true;
    this.turnGeneration++;
    this.outputBytes = 0;
    const deadline = AbortSignal.timeout(this.options.launch.promptTimeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    try {
      const info = await this.connect(signal);
      const connection = this.connection!;
      this.onUpdate = input.onUpdate;
      this.onPermission = input.onPermission;
      this.turnSignal = signal;
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (): void => {
        void connection.agent.notify("session/cancel", { sessionId: info.sessionId }).catch(() => undefined);
        timer = setTimeout(() => { void this.close(); }, 1_000);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (input.model !== "default" && input.model !== info.currentModel) {
          if (!info.models.some((model) => model.id === input.model)) throw new Error(`ACP 模型不可用：${input.model}`);
          if (info.modelConfigId) {
            const changed = await connection.agent.request("session/set_config_option", { sessionId: info.sessionId, configId: info.modelConfigId, value: input.model });
            this.info = { ...info, ...configInfo(changed.configOptions) };
          } else await connection.agent.request("session/set_model", { sessionId: info.sessionId, modelId: input.model });
          info.currentModel = input.model;
        }
        signal.throwIfAborted();
        const response = await connection.agent.request("session/prompt", { sessionId: info.sessionId, prompt: input.content });
        if (deadline.aborted && !input.signal?.aborted) throw deadline.reason;
        return input.signal?.aborted ? "cancelled" : response.stopReason;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      const timeout = deadline.aborted && !input.signal?.aborted;
      const failure = this.safeError(timeout ? new Error("ACP 回合执行超时，未自动重放。") : error);
      if (timeout) failure.name = "TimeoutError";
      await this.close();
      throw failure;
    } finally { this.turnGeneration++; this.busy = false; this.onUpdate = undefined; this.onPermission = undefined; this.turnSignal = undefined; }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.turnGeneration++;
    this.child = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.info = undefined;
    this.fingerprint = undefined;
    if (!child) return;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") child.kill(signal);
        else if (code !== "ESRCH") throw error;
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { kill("SIGKILL"); }, 1_000);
      child.once("exit", () => { clearTimeout(timer); kill("SIGKILL"); resolve(); });
      child.once("error", () => { clearTimeout(timer); resolve(); });
      kill("SIGTERM");
      if (!child.pid) { clearTimeout(timer); resolve(); }
    });
  }

  private safeError(error: unknown): Error {
    let message = `${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr}` : ""}`;
    for (const value of this.redactions) message = message.replaceAll(value, "[redacted]");
    return new Error(Buffer.from(redactSecrets(message), "utf8").subarray(0, 8192).toString("utf8"));
  }

  private async readBinding(): Promise<AcpSessionBinding | undefined> {
    if (!this.options.bindingFile) return undefined;
    try {
      const binding = JSON.parse(await fs.readFile(this.options.bindingFile, "utf8")) as AcpSessionBinding;
      if (binding.version !== 1 || typeof binding.fingerprint !== "string" || typeof binding.sessionId !== "string") throw new Error("ACP 会话关联损坏，请新建会话。");
      return binding;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async writeBinding(binding: AcpSessionBinding): Promise<void> {
    const file = this.options.bindingFile;
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(binding), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}

function sessionInfo(sessionId: string, response: unknown): AcpSessionInfo {
  const value = response as { configOptions?: SessionConfigOption[]; models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> };
    modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string }> } } | undefined;
  return { sessionId, models: value?.models?.availableModels?.map((model) => ({ id: model.modelId, name: model.name })) ?? [],
    modes: value?.modes?.availableModes ?? [], currentModel: value?.models?.currentModelId, currentMode: value?.modes?.currentModeId, ...configInfo(value?.configOptions) };
}

function configInfo(options?: SessionConfigOption[]): Partial<AcpSessionInfo> {
  const result: Partial<AcpSessionInfo> = {};
  for (const option of options ?? []) {
    if (option.type !== "select" || (option.category !== "model" && option.category !== "mode")) continue;
    const choices = option.options.flatMap((entry) => "group" in entry ? entry.options : [entry]).map((entry) => ({ id: entry.value, name: entry.name }));
    if (option.category === "model") { result.models = choices; result.currentModel = option.currentValue; result.modelConfigId = option.id; }
    else { result.modes = choices; result.currentMode = option.currentValue; result.modeConfigId = option.id; }
  }
  return result;
}
