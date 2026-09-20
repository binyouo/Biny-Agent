/**
 * MCP 服务器编辑表单的草稿模型与纯转换逻辑。
 *
 * 只负责表单值与协议草稿之间的折算（字段 mutation、参数拆分、剪贴板导入），
 * 不含任何渲染逻辑，方便单独测试。
 */
import type {
  DesktopMcpCatalogInstallation,
  DesktopMcpFieldAction,
  DesktopMcpFieldMutation,
  DesktopMcpRemoteProtocol,
  DesktopMcpServerDraft,
  DesktopMcpTransport
} from "../../protocol.js";

export interface FieldRow {
  key: string;
  value: string;
  action: DesktopMcpFieldAction;
  placeholder?: string;
  required?: boolean;
}

export interface McpDraftForm {
  name: string;
  description: string;
  transport: DesktopMcpTransport;
  command: string;
  argsText: string;
  cwd: string;
  stderr: "ignore" | "inherit" | "pipe";
  url: string;
  remoteProtocol: DesktopMcpRemoteProtocol;
  oauthEnabled?: boolean;
  oauthClientId?: string;
  oauthScopes?: string;
  oauthRedirectPort?: string;
  timeoutMs: string;
  env: FieldRow[];
  headers: FieldRow[];
  /** 编辑已保存服务器时原有的持久化字段 key；行被删除或改名后，保存时要对这些 key 显式 clear。 */
  savedEnvKeys: string[];
  savedHeaderKeys: string[];
}

export const EMPTY_DRAFT: McpDraftForm = {
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  argsText: "",
  cwd: "",
  stderr: "ignore",
  url: "",
  remoteProtocol: "streamable-http",
  timeoutMs: "",
  env: [],
  headers: [],
  savedEnvKeys: [],
  savedHeaderKeys: []
};

export function toProtocolDraft(draft: McpDraftForm): DesktopMcpServerDraft {
  const name = draft.name.trim();
  if (!name) throw new Error("请输入服务器名称。");
  const timeoutMs = draft.timeoutMs.trim() ? Number(draft.timeoutMs.trim()) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) throw new Error("连接超时需要是 1000 到 600000 之间的整数。");
  const redirectPort = draft.oauthRedirectPort?.trim() ? Number(draft.oauthRedirectPort) : undefined;
  if (redirectPort !== undefined && (!Number.isInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535)) throw new Error("OAuth 回调端口需要是 1024 到 65535 之间的整数。");
  return {
    name,
    description: draft.description.trim() || undefined,
    transport: draft.transport,
    command: draft.transport === "stdio" ? draft.command.trim() || undefined : undefined,
    args: parseArguments(draft.argsText),
    cwd: draft.cwd.trim() || undefined,
    stderr: draft.stderr,
    url: draft.transport === "remote" ? draft.url.trim() || undefined : undefined,
    remoteProtocol: draft.transport === "remote" ? draft.remoteProtocol : undefined,
    oauth: draft.transport === "remote" && draft.oauthEnabled ? {
      clientId: draft.oauthClientId?.trim() || undefined,
      scopes: draft.oauthScopes?.trim() ? draft.oauthScopes.trim().split(/\s+/u) : undefined,
      redirectPort
    } : undefined,
    timeoutMs,
    env: toFieldMutations(draft.env, draft.savedEnvKeys),
    headers: toFieldMutations(draft.headers, draft.savedHeaderKeys)
  };
}

export function toFieldMutations(rows: FieldRow[], persistedKeys: string[]): DesktopMcpFieldMutation[] {
  const mutations: DesktopMcpFieldMutation[] = [];
  const remaining = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    remaining.add(key);
    if (row.action === "keep" && !row.value) {
      mutations.push({ key, action: "keep" });
      continue;
    }
    if (row.action === "set" && !row.value && row.required) throw new Error(`请填写 ${key} 的值。`);
    if (row.action === "set" && !row.value) continue;
    mutations.push({ key, action: row.action, value: row.action === "set" ? row.value : undefined });
  }
  // 主进程对未提及的 key 一律保留旧值；被删除或改名的持久化 key 必须显式 clear，否则删除不生效。
  for (const key of persistedKeys) {
    if (!remaining.has(key)) mutations.push({ key, action: "clear" });
  }
  return mutations;
}

export function parseArguments(value: string): string[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  // 多行时每行即一个参数，含空格的路径不能被拆开；单行输入保留空格分隔的兼容行为。
  if (lines.length <= 1) return lines[0]?.split(/\s+/) ?? [];
  return lines;
}

export function parameterValues(installation: DesktopMcpCatalogInstallation): Record<string, string> {
  return Object.fromEntries(installation.parameters.map((parameter) => [parameter.key, ""]));
}

export function parseClipboardConfig(value: unknown): McpDraftForm | undefined {
  if (!isRecord(value)) return undefined;
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  const first = Object.entries(servers).find(([, candidate]) => isRecord(candidate));
  if (!first || !isRecord(first[1])) return undefined;
  const config = first[1];
  const transport: DesktopMcpTransport = typeof config.url === "string" ? "remote" : "stdio";
  return {
    ...EMPTY_DRAFT,
    name: first[0],
    description: typeof config.description === "string" ? config.description : "",
    transport,
    command: typeof config.command === "string" ? config.command : "",
    argsText: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === "string").join("\n") : "",
    cwd: typeof config.cwd === "string" ? config.cwd : "",
    stderr: config.stderr === "inherit" || config.stderr === "pipe" ? config.stderr : "ignore",
    url: typeof config.url === "string" ? config.url : "",
    // 部分客户端用 "type": "sse" 声明传输协议，与 transportProtocol 写法一并兼容。
    remoteProtocol: config.transportProtocol === "sse" || config.type === "sse" ? "sse" : "streamable-http",
    oauthEnabled: isRecord(config.oauth),
    oauthClientId: isRecord(config.oauth) && typeof config.oauth.clientId === "string" ? config.oauth.clientId : "",
    oauthScopes: isRecord(config.oauth) && Array.isArray(config.oauth.scopes) ? config.oauth.scopes.filter((scope): scope is string => typeof scope === "string").join(" ") : "",
    oauthRedirectPort: isRecord(config.oauth) && typeof config.oauth.redirectPort === "number" ? String(config.oauth.redirectPort) : "",
    timeoutMs: typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "",
    env: recordRows(config.env),
    headers: recordRows(config.headers)
  };
}

function recordRows(value: unknown): FieldRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter(([, candidate]) => typeof candidate === "string").map(([key, candidate]) => ({ key, value: String(candidate), action: "set" }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
