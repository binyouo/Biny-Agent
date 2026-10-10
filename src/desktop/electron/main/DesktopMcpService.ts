/**
 * Desktop MCP 管理服务。
 *
 * 这里负责全局 MCP 配置的脱敏投影、CAS 保存、一次性连通性测试和在线目录解析；
 * 实际长期连接仍由每个项目的 CommandRuntime 持有，避免 Desktop 管理页重复启动 MCP 进程。
 */
import { randomUUID } from "node:crypto";
import { globalConfigDir } from "../../../config/paths.js";
import { configSchema, defaultConfig, type AgentConfig, type McpServerConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import type {
  DesktopMcpCatalogEntry,
  DesktopMcpCatalogInstallation,
  DesktopMcpCatalogParameter,
  DesktopMcpCatalogState,
  DesktopMcpFieldMutation,
  DesktopMcpServerDetails,
  DesktopMcpServerDraft,
  DesktopMcpServerSummary,
  DesktopMcpSnapshot,
  DesktopMcpTestResult
} from "../../protocol.js";
import { McpToolHost, type McpServerStatus } from "../../../extensions/mcp.js";
import { desktopComputerMcpName } from "../../../computer/desktopMcp.js";
import { getSharedProxyAwareFetch } from "../../../network/proxyFetch.js";
import { ToolRegistry } from "../../../tools/registry.js";
import type { DesktopProjectService } from "./DesktopProjectService.js";
import { McpOAuthLogins, McpOAuthProvider, type McpOAuthLogin } from "../../../extensions/mcpOAuth.js";

export const MCP_CATALOG_URL = "https://ravitemer.github.io/mcp-registry/registry.json";

const catalogTimeoutMs = 12_000;
const catalogMaxBytes = 5 * 1024 * 1024;
const maxServerNameLength = 120;
const maxFieldKeyLength = 200;

interface CatalogStateInternal extends DesktopMcpCatalogState {
  entries: DesktopMcpCatalogEntry[];
}

interface McpRuntimeBridge {
  assertNoRunningTasks(message?: string): void;
  refreshMcpRuntimes(): Promise<void>;
  mcpStatuses(projectId: string): Promise<McpServerStatus[] | undefined>;
  mcpReconnect(projectId: string, serverName: string): Promise<McpServerStatus>;
  mcpDetails(projectId: string, serverName: string): Promise<{
    status: McpServerStatus;
    resources: Array<Record<string, unknown>>;
  }>;
}

export class DesktopMcpService {
  private readonly logins = new McpOAuthLogins();
  private readonly startingLogins = new Set<string>();
  private readonly loginServers = new Map<string, { projectId?: string; name: string; config: McpServerConfig }>();
  private catalogState: CatalogStateInternal = {
    status: "idle",
    source: MCP_CATALOG_URL,
    entries: [],
    categories: [],
    fetchedAt: undefined,
    error: undefined
  };

  constructor(
    private readonly configStore: AgentConfigStore,
    private readonly projects: DesktopProjectService,
    private readonly agents: McpRuntimeBridge,
    private readonly fetcher: typeof globalThis.fetch = getSharedProxyAwareFetch()
  ) {}

  async snapshot(projectId?: string): Promise<DesktopMcpSnapshot> {
    const workspaceRoot = this.workspaceRoot(projectId);
    const stored = await this.loadVersioned(workspaceRoot);
    const live = projectId === undefined ? undefined : await this.agents.mcpStatuses(projectId);
    return {
      configRevision: stored.revision,
      servers: [...Object.entries(stored.config.extensions.mcp).map(([name, server]) => describeServer(name, server, live)), describeBuiltinComputerServer(live)],
      catalog: cloneCatalogState(this.catalogState)
    };
  }

  catalog(): DesktopMcpCatalogState {
    return cloneCatalogState(this.catalogState);
  }

  async loginStart(projectId: string | undefined, name: string): Promise<McpOAuthLogin> {
    this.agents.assertNoRunningTasks("请在任务结束后登录 MCP。");
    const stored = await this.loadVersioned(this.workspaceRoot(projectId));
    const config = stored.config.extensions.mcp[normalizeServerName(name)];
    if (!config?.enabled || !config.oauth || !config.url) throw new Error("请先保存并启用使用 OAuth 的远程 MCP 服务。");
    if (this.startingLogins.has(name)) throw new Error("此 MCP 正在准备登录，请稍候。");
    this.startingLogins.add(name);
    try {
      for (const [id, pending] of this.loginServers) if (pending.name === name) await this.loginCancel(id);
      const login = await this.logins.start(config);
      this.loginServers.set(login.id, { projectId, name, config });
      return login;
    } finally { this.startingLogins.delete(name); }
  }

  async loginFinish(projectId: string | undefined, name: string, id: string): Promise<DesktopMcpSnapshot> {
    const pending = this.loginServers.get(id);
    if (!pending || pending.name !== name || pending.projectId !== projectId) throw new Error("MCP 登录与当前服务不匹配。");
    try {
      await this.logins.finish(id, async () => {
        const stored = await this.loadVersioned(this.workspaceRoot(projectId));
        if (JSON.stringify(stored.config.extensions.mcp[name]) !== JSON.stringify(pending.config)) throw new Error("MCP 配置已改变，请重新登录。");
      });
      try { await this.agents.refreshMcpRuntimes(); }
      catch (error) { throw new Error(`MCP 授权已保存，但运行时尚未刷新：${errorText(error)}。请在任务结束后点击连接。`); }
      return await this.snapshot(projectId);
    } finally { this.loginServers.delete(id); }
  }

  async loginCancel(id: string): Promise<void> { await this.logins.cancel(id); this.loginServers.delete(id); }

  async logout(projectId: string | undefined, name: string): Promise<DesktopMcpSnapshot> {
    this.agents.assertNoRunningTasks("请在任务结束后退出 MCP 登录。");
    const stored = await this.loadVersioned(this.workspaceRoot(projectId));
    const config = stored.config.extensions.mcp[normalizeServerName(name)];
    if (!config?.oauth || !config.url) throw new Error("此 MCP 未使用 OAuth。");
    for (const [id, pending] of this.loginServers) if (pending.name === name) await this.loginCancel(id);
    await new McpOAuthProvider(config).logout();
    await this.agents.refreshMcpRuntimes();
    return await this.snapshot(projectId);
  }

  async dispose(): Promise<void> { await this.logins.dispose(); this.loginServers.clear(); }

  async refreshCatalog(): Promise<DesktopMcpCatalogState> {
    const previous = this.catalogState;
    this.catalogState = {
      ...previous,
      status: "loading",
      error: undefined
    };
    try {
      const response = await this.fetcher(MCP_CATALOG_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(catalogTimeoutMs)
      });
      if (!response.ok) throw new Error(`MCP 市场请求失败：HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > catalogMaxBytes) throw new Error("MCP 市场响应过大。");
      const normalized = normalizeCatalog(JSON.parse(text) as unknown);
      this.catalogState = {
        status: "ready",
        source: MCP_CATALOG_URL,
        fetchedAt: new Date().toISOString(),
        entries: normalized.entries,
        categories: normalized.categories,
        error: undefined
      };
    } catch (error) {
      this.catalogState = {
        ...previous,
        status: previous.entries.length ? "stale" : "error",
        error: errorText(error)
      };
    }
    return this.catalog();
  }

  async upsertServer(
    projectId: string | undefined,
    originalName: string | undefined,
    draft: DesktopMcpServerDraft,
    expectedConfigRevision: string
  ): Promise<DesktopMcpSnapshot> {
    this.agents.assertNoRunningTasks("任务运行期间不能修改 MCP 服务器配置。");
    const workspaceRoot = this.workspaceRoot(projectId);
    const current = await this.loadVersioned(workspaceRoot);
    const name = normalizeServerName(draft.name);
    if (name === desktopComputerMcpName) throw new Error("此名称由内置 Computer Use MCP 使用；请在 Computer Use 设置中管理权限。");
    const oldName = originalName === undefined ? undefined : normalizeServerName(originalName);
    const existing = oldName === undefined ? undefined : current.config.extensions.mcp[oldName];
    if (oldName !== undefined && existing === undefined) throw new Error(`MCP 服务器不存在：${oldName}`);
    if (oldName !== name && current.config.extensions.mcp[name] !== undefined) {
      throw new Error(`MCP 服务器名称已存在：${name}`);
    }

    const targetServer = buildServerConfig(existing, draft);
    const next = structuredClone(current.config);
    next.extensions.mcp = { ...next.extensions.mcp };
    if (oldName !== undefined && oldName !== name) delete next.extensions.mcp[oldName];
    next.extensions.mcp[name] = targetServer;
    const parsed = configSchema.parse(next);
    for (const [id, pending] of this.loginServers) if (pending.name === name || pending.name === oldName) await this.loginCancel(id);
    await this.saveVersioned(parsed, current.revision, workspaceRoot, expectedConfigRevision);
    await this.agents.refreshMcpRuntimes();
    return await this.snapshot(projectId);
  }

  async setEnabled(
    projectId: string | undefined,
    name: string,
    enabled: boolean,
    expectedConfigRevision: string
  ): Promise<DesktopMcpSnapshot> {
    this.agents.assertNoRunningTasks("任务运行期间不能修改 MCP 服务器配置。");
    const workspaceRoot = this.workspaceRoot(projectId);
    const current = await this.loadVersioned(workspaceRoot);
    const serverName = normalizeServerName(name);
    const existing = current.config.extensions.mcp[serverName];
    if (existing === undefined) throw new Error(`MCP 服务器不存在：${serverName}`);
    const next = structuredClone(current.config);
    next.extensions.mcp = { ...next.extensions.mcp, [serverName]: { ...existing, enabled } };
    for (const [id, pending] of this.loginServers) if (pending.name === serverName) await this.loginCancel(id);
    await this.saveVersioned(configSchema.parse(next), current.revision, workspaceRoot, expectedConfigRevision);
    await this.agents.refreshMcpRuntimes();
    return await this.snapshot(projectId);
  }

  async deleteServer(
    projectId: string | undefined,
    name: string,
    expectedConfigRevision: string
  ): Promise<DesktopMcpSnapshot> {
    this.agents.assertNoRunningTasks("任务运行期间不能修改 MCP 服务器配置。");
    const workspaceRoot = this.workspaceRoot(projectId);
    const current = await this.loadVersioned(workspaceRoot);
    const serverName = normalizeServerName(name);
    if (current.config.extensions.mcp[serverName] === undefined) throw new Error(`MCP 服务器不存在：${serverName}`);
    const next = structuredClone(current.config);
    next.extensions.mcp = { ...next.extensions.mcp };
    delete next.extensions.mcp[serverName];
    for (const [id, pending] of this.loginServers) if (pending.name === serverName) await this.loginCancel(id);
    await this.saveVersioned(configSchema.parse(next), current.revision, workspaceRoot, expectedConfigRevision);
    const removed = current.config.extensions.mcp[serverName];
    if (removed?.oauth) await new McpOAuthProvider(removed).logout();
    await this.agents.refreshMcpRuntimes();
    return await this.snapshot(projectId);
  }

  async testServer(projectId: string | undefined, draft: DesktopMcpServerDraft): Promise<DesktopMcpTestResult> {
    let host: McpToolHost | undefined;
    try {
      const serverName = normalizeServerName(draft.name || "test-server");
      const server = buildServerConfig(undefined, { ...draft, name: serverName });
      const config = configSchema.parse({
        ...defaultConfig,
        extensions: { ...defaultConfig.extensions, mcp: { [serverName]: server } }
      });
      host = new McpToolHost();
      await host.connectConfiguredServers(this.workspaceRoot(projectId), config, new ToolRegistry());
      const status = host.listServers()[0];
      if (!status?.connected) {
        return {
          success: false,
          state: "failed",
          toolNames: status?.toolNames ?? [],
          promptNames: status?.promptNames ?? [],
          hasResources: status?.hasResources ?? false,
          error: status?.lastError ?? "MCP 服务器未能建立连接。"
        };
      }
      return {
        success: true,
        state: "connected",
        toolNames: status.toolNames,
        promptNames: status.promptNames,
        hasResources: status.hasResources,
        message: `已连接，发现 ${status.toolNames.length} 个工具。`
      };
    } catch (error) {
      return {
        success: false,
        state: "failed",
        toolNames: [],
        promptNames: [],
        hasResources: false,
        error: errorText(error)
      };
    } finally {
      await host?.close();
    }
  }

  async reconnect(projectId: string, name: string): Promise<DesktopMcpServerSummary> {
    const status = await this.agents.mcpReconnect(projectId, normalizeServerName(name));
    const snapshot = await this.snapshot(projectId);
    const summary = snapshot.servers.find((server) => server.name === status.name);
    if (!summary) throw new Error(`MCP 服务器状态不存在：${status.name}`);
    return summary;
  }

  async details(projectId: string, name: string): Promise<DesktopMcpServerDetails> {
    const status = await this.agents.mcpDetails(projectId, normalizeServerName(name));
    const snapshot = await this.snapshot(projectId);
    const summary = snapshot.servers.find((server) => server.name === status.status.name);
    if (!summary) throw new Error(`MCP 服务器状态不存在：${status.status.name}`);
    return {
      server: summary,
      resources: status.resources
        .filter((resource) => typeof resource.uri === "string")
        .map((resource) => ({
          uri: String(resource.uri),
          name: optionalText(resource.name),
          description: optionalText(resource.description),
          mimeType: optionalText(resource.mimeType)
        }))
    };
  }

  private workspaceRoot(projectId: string | undefined): string {
    return projectId === undefined ? globalConfigDir() : this.projects.requireProject(projectId).path;
  }

  private async loadVersioned(workspaceRoot: string) {
    if (!this.configStore.loadVersioned) throw new Error("MCP 管理需要版本化配置存储。");
    return await this.configStore.loadVersioned(workspaceRoot);
  }

  private async saveVersioned(
    config: AgentConfig,
    actualRevision: string,
    workspaceRoot: string,
    expectedRevision: string
  ): Promise<void> {
    if (actualRevision !== expectedRevision) {
      throw new Error(`MCP 配置已被其他客户端修改，请刷新后重试。当前 revision：${actualRevision}`);
    }
    if (!this.configStore.saveVersioned) throw new Error("MCP 管理需要版本化配置存储。");
    await this.configStore.saveVersioned(config, expectedRevision, workspaceRoot);
  }
}

function buildServerConfig(existing: McpServerConfig | undefined, draft: DesktopMcpServerDraft): McpServerConfig {
  const transport = draft.transport;
  const serverId = existing?.id ?? randomUUID();
  const env = applyFieldMutations(existing?.env, existing?.credentialRefs?.env, draft.env, serverId, "env");
  const headers = applyFieldMutations(existing?.headers, existing?.credentialRefs?.headers, draft.headers, serverId, "headers");
  const credentialRefs = {
    env: env.refs,
    headers: headers.refs
  };
  const hasCredentialRefs = Object.keys(credentialRefs.env).length > 0 || Object.keys(credentialRefs.headers).length > 0;
  return {
    id: serverId,
    toolContracts: existing?.toolContracts,
    description: optionalText(draft.description),
    type: transport === "remote" ? "http" : "stdio",
    transportProtocol: transport === "remote" ? draft.remoteProtocol ?? "streamable-http" : undefined,
    command: transport === "stdio" ? requiredText(draft.command, "Stdio 命令") : undefined,
    args: transport === "stdio" ? draft.args.map((arg) => arg.trim()).filter(Boolean) : [],
    env: Object.keys(env.values).length ? env.values : undefined,
    credentialRefs: hasCredentialRefs ? credentialRefs : undefined,
    cwd: transport === "stdio" ? optionalText(draft.cwd) : undefined,
    stderr: transport === "stdio" ? draft.stderr ?? "ignore" : "ignore",
    url: transport === "remote"
      ? requiredText(
          existing?.url && optionalText(draft.url) === redactEndpoint(existing.url) ? existing.url : draft.url,
          "Remote URL"
        )
      : undefined,
    headers: Object.keys(headers.values).length ? headers.values : undefined,
    oauth: transport === "remote" ? draft.oauth : undefined,
    startupTimeoutMs: draft.startupTimeoutMs,
    timeoutMs: draft.timeoutMs,
    enabled: existing?.enabled ?? true
  };
}

function applyFieldMutations(
  initialValues: Record<string, string> | undefined,
  initialRefs: Record<string, string> | undefined,
  mutations: DesktopMcpFieldMutation[],
  serverId: string,
  location: "env" | "headers"
): { values: Record<string, string>; refs: Record<string, string> } {
  const values = { ...(initialValues ?? {}) };
  const refs = { ...(initialRefs ?? {}) };
  const seen = new Set<string>();
  for (const mutation of mutations) {
    const key = validateFieldKey(mutation.key);
    if (seen.has(key)) throw new Error(`MCP 字段重复：${key}`);
    seen.add(key);
    if (mutation.action === "clear") {
      delete values[key];
      delete refs[key];
      continue;
    }
    if (mutation.action === "set") {
      if (mutation.value === undefined || mutation.value.length > 16_000) throw new Error(`MCP 字段值无效：${key}`);
      values[key] = mutation.value;
      // 非 macOS 没有凭据持久化后端；`${ENV_NAME}` 是 MCP 自身支持的环境变量引用，
      // 直接保留在配置中，避免把明文值写进文件或让保存流程伪装成成功。
      if (isEnvironmentReference(mutation.value)) delete refs[key];
      else refs[key] ??= mcpCredentialAccount(serverId, location, key);
      continue;
    }
    if (values[key] !== undefined && refs[key] === undefined) refs[key] = mcpCredentialAccount(serverId, location, key);
  }
  return { values, refs };
}

function mcpCredentialAccount(serverId: string, location: "env" | "headers", key: string): string {
  return `mcp:${serverId}:${location}:${encodeURIComponent(key)}`;
}

function isEnvironmentReference(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value);
}

function describeBuiltinComputerServer(live: McpServerStatus[] | undefined): DesktopMcpServerSummary {
  const runtime = live?.find(server => server.name === desktopComputerMcpName && server.transport === "in-process");
  return {
    name: desktopComputerMcpName, builtin: true, description: "内置桌面控制服务，由工作区 Runtime 自动连接；启用和应用授权在 Computer Use 设置中管理。",
    transport: "in-process", commandOrUrl: "Desktop control plane · in-process MCP", args: [], enabled: true,
    state: !runtime ? "not-started" : runtime.connecting ? "connecting" : runtime.connected ? "connected" : "disconnected",
    toolNames: runtime?.toolNames ?? ["ComputerList", "ComputerObserve", "ComputerAction", "ComputerMirror"], promptNames: [], hasResources: false, environmentKeys: [], headerNames: [], lastError: runtime?.lastError
  };
}

function describeServer(name: string, config: McpServerConfig, live: McpServerStatus[] | undefined): DesktopMcpServerSummary {
  const transport = (config.type ?? (config.url ? "http" : "stdio")) === "http" ? "remote" : "stdio";
  const runtime = live?.find((server) => server.name === name);
  return {
    name,
    id: config.id,
    description: config.description,
    transport,
    remoteProtocol: transport === "remote" ? config.transportProtocol ?? "streamable-http" : undefined,
    commandOrUrl: transport === "remote" ? redactEndpoint(config.url ?? "") : config.command ?? "",
    args: [...(config.args ?? [])],
    cwd: config.cwd,
    stderr: config.stderr,
    startupTimeoutMs: config.startupTimeoutMs,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled,
    state: !config.enabled
      ? "disabled"
      : runtime === undefined
        ? "not-started"
        : runtime.connecting
          ? "connecting"
          : runtime.connected
            ? "connected"
            : "disconnected",
    toolNames: runtime?.toolNames ?? [],
    promptNames: runtime?.promptNames ?? [],
    hasResources: runtime?.hasResources ?? false,
    environmentKeys: Object.keys(config.env ?? {}),
    headerNames: Object.keys(config.headers ?? {}),
    lastError: runtime?.lastError,
    oauth: config.oauth,
    authRequired: runtime?.authRequired
  };
}

function normalizeCatalog(value: unknown): { entries: DesktopMcpCatalogEntry[]; categories: string[] } {
  if (!isRecord(value) || !Array.isArray(value.servers)) throw new Error("MCP 市场格式无效：缺少 servers。");
  const entries: DesktopMcpCatalogEntry[] = [];
  for (const raw of value.servers) {
    if (!isRecord(raw)) continue;
    const name = optionalText(raw.name);
    const id = optionalText(raw.id) ?? name;
    if (!name || !id || !Array.isArray(raw.installations)) continue;
    const installations = raw.installations.map((installation) => normalizeInstallation(installation)).filter((item): item is DesktopMcpCatalogInstallation => item !== undefined);
    if (!installations.length) continue;
    entries.push({
      id,
      name,
      description: optionalText(raw.description) ?? "",
      author: optionalText(raw.author),
      category: optionalText(raw.category),
      tags: textArray(raw.tags),
      verified: raw.verified === true,
      featured: raw.featured === true,
      repositoryUrl: firstText(raw.repository, raw.repo, raw.repositoryUrl),
      websiteUrl: firstText(raw.url, raw.website, raw.websiteUrl),
      installations
    });
  }
  const categories = [...new Set(entries.map((entry) => entry.category).filter((category): category is string => Boolean(category)))].sort((a, b) => a.localeCompare(b));
  return { entries, categories };
}

function normalizeInstallation(value: unknown): DesktopMcpCatalogInstallation | undefined {
  if (!isRecord(value)) return undefined;
  const name = optionalText(value.name) ?? "默认配置";
  const parsed = parseRecipe(value.config);
  if (!parsed) return undefined;
  const transports = textArray(value.transports).map((item) => item.toLowerCase());
  const transport = parsed.url ? "remote" : "stdio";
  const remoteProtocol = transport === "remote"
    ? transports.some((item) => item.includes("sse")) && !transports.some((item) => item.includes("streamable"))
      ? "sse"
      : "streamable-http"
    : undefined;
  const parameters = Array.isArray(value.parameters)
    ? value.parameters.map((item) => normalizeParameter(item)).filter((item): item is DesktopMcpCatalogParameter => item !== undefined)
    : [];
  return {
    name,
    transport,
    remoteProtocol,
    command: parsed.command,
    args: parsed.args,
    url: parsed.url,
    parameters,
    tags: textArray(value.tags)
  };
}

function parseRecipe(value: unknown): { command?: string; args: string[]; url?: string } | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;
  let candidate: Record<string, unknown> = parsed;
  const servers = parsed.mcpServers;
  if (isRecord(servers)) {
    const first = Object.values(servers)[0];
    if (!isRecord(first)) return undefined;
    candidate = first;
  }
  const command = optionalText(candidate.command);
  const url = optionalText(candidate.url);
  if (!command && !url) return undefined;
  return {
    command,
    args: Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === "string") : [],
    url
  };
}

function normalizeParameter(value: unknown): DesktopMcpCatalogParameter | undefined {
  if (!isRecord(value)) return undefined;
  const name = optionalText(value.name);
  const key = optionalText(value.key) ?? name;
  if (!name || !key) return undefined;
  return {
    name,
    key,
    placeholder: optionalText(value.placeholder),
    required: value.required !== false
  };
}

function cloneCatalogState(state: CatalogStateInternal): DesktopMcpCatalogState {
  return structuredClone(state);
}

function normalizeServerName(value: string): string {
  const name = value.trim();
  if (!name || name.length > maxServerNameLength || /[\r\n]/u.test(name)) throw new Error("MCP 服务器名称无效。");
  return name;
}

function validateFieldKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > maxFieldKeyLength || /[\r\n=]/u.test(key)) throw new Error(`MCP 字段名无效：${value}`);
  return key;
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空。`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = optionalText(value);
    if (text) return text;
  }
  return undefined;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function redactEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
