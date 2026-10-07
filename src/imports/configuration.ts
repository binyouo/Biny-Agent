/** Read-only source adapters; importing configuration never starts an MCP server. */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { configSchema, defaultConfig, type AgentConfig } from "../config/schema.js";
import { updateConfig, type AgentConfigStore } from "../config/store.js";

export type ConfigurationImportSource = "claude" | "codex";
export interface ConfigurationImportCandidate {
  id: string;
  category: "settings" | "mcp";
  label: string;
  detail: string;
  fingerprint: string;
  apply(workspaceRoot: string, store: AgentConfigStore): Promise<{ status: "imported" | "skipped"; detail?: string }>;
}
type Provider = AgentConfig["providers"][string];
type McpServer = AgentConfig["extensions"]["mcp"][string];
const maxSourceBytes = 2 * 1024 * 1024;
const skippedUnsupported = { status: "skipped", detail: "来源配置无法完整映射，未导入。" } as const;
const skippedConflict = { status: "skipped", detail: "Biny 已有同名配置，保留现有设置。" } as const;

export async function discoverConfigurationImports(source: ConfigurationImportSource, homeDir: string): Promise<ConfigurationImportCandidate[]> {
  try {
    const home = await fs.realpath(homeDir);
    const locations = source === "claude" ? [".claude/settings.json", ".claude.json"] : [".codex/config.toml", ".codex/auth.json"];
    const contents = await Promise.all(locations.map(relative => readSource(home, relative)));
    const documents = contents.map((bytes, index) => {
      if (bytes === undefined) return {};
      const parsed: unknown = source === "codex" && index === 0
        ? parseToml(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { unsafeKeyBehaviour: "throw" }) : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(parsed)) throw new Error("configuration_import_source_invalid");
      return parsed;
    });
    const fingerprint = createHash("sha256").update(JSON.stringify(contents.map((bytes, index) => [locations[index], bytes?.toString("base64") ?? null]))).digest("hex");
    const secrets = credentialValues(documents);
    const [settings = {}, auxiliary = {}] = documents;
    const candidates: ConfigurationImportCandidate[] = [];
    const model = source === "claude" ? claudeModel(settings) : codexModel(settings, auxiliary);
    if (model !== undefined) candidates.push(modelCandidate(source, model, fingerprint));
    const serverEntries = source === "claude"
      ? [...entries(settings.mcpServers), ...entries(auxiliary.mcpServers)] : entries(settings.mcp_servers);
    const counts = new Map<string, number>();
    for (const [name] of serverEntries) counts.set(name, (counts.get(name) ?? 0) + 1);
    const serverNames = new Set<string>();
    for (const [name, raw] of serverEntries) {
      if (serverNames.has(name)) continue;
      serverNames.add(name);
      const duplicate = (counts.get(name) ?? 0) > 1;
      const server = duplicate ? undefined : mapMcpServer(source, raw);
      const nameId = createHash("sha256").update(name).digest("hex").slice(0, 24);
      candidates.push({
        id: `${source}:mcp:${nameId}`, category: "mcp", label: `${source === "claude" ? "Claude" : "Codex"} MCP：${safeLabel(name, secrets)}`,
        detail: "导入后保持停用，可在 MCP 设置中启用。", fingerprint,
        async apply(workspaceRoot, store) {
          if (server === undefined || unsafeName(name)) return skippedUnsupported;
          try {
            await updateConfig(store, workspaceRoot, current => {
              if (Object.hasOwn(current.extensions.mcp, name)) throw new ConfigurationConflict();
              return configSchema.parse({ ...current, extensions: { ...current.extensions, mcp: { ...current.extensions.mcp, [name]: server } } });
            });
            return { status: "imported" };
          } catch (error) {
            if (error instanceof ConfigurationConflict) return skippedConflict;
            throw new Error("configuration_import_apply_failed");
          }
        }
      });
    }
    return candidates;
  } catch {
    throw new Error("configuration_import_source_invalid");
  }
}

class ConfigurationConflict extends Error {}
interface ImportedModel { model: string; provider: Provider }
function modelCandidate(source: ConfigurationImportSource, model: ImportedModel | null, fingerprint: string): ConfigurationImportCandidate {
  const alias = `imported-${source}`;
  return {
    id: `${source}:model`, category: "settings", label: `${source === "claude" ? "Claude" : "Codex"} 模型设置`,
    detail: "添加来源选用的模型，保留 Biny 当前默认模型。", fingerprint,
    async apply(workspaceRoot, store) {
      if (model === null) return skippedUnsupported;
      try {
        await updateConfig(store, workspaceRoot, current => {
          if (Object.hasOwn(current.providers, alias) || Object.hasOwn(current.models, alias)) throw new ConfigurationConflict();
          return configSchema.parse({ ...current, providers: { ...current.providers, [alias]: model.provider },
            models: { ...current.models, [alias]: { provider: alias, model: model.model } } });
        });
        return { status: "imported" };
      } catch (error) {
        if (error instanceof ConfigurationConflict) return skippedConflict;
        throw new Error("configuration_import_apply_failed");
      }
    }
  };
}

function claudeModel(settings: Record<string, unknown>): ImportedModel | null | undefined {
  const env = isRecord(settings.env) ? settings.env : {};
  const model = string(env.ANTHROPIC_MODEL) ?? string(settings.model);
  if (model === undefined && !Object.keys(env).some(key => key.startsWith("ANTHROPIC_"))) return undefined;
  // Source shorthand names and bearer-token routing have no exact Biny API-key representation.
  if (!model || ["sonnet", "opus", "haiku", "default"].includes(model) || string(env.ANTHROPIC_AUTH_TOKEN)) return null;
  const apiKey = string(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const endpoint = string(env.ANTHROPIC_BASE_URL);
  // The source client appends /v1/messages; Biny's provider accepts the versioned base.
  const baseUrl = endpoint === undefined ? undefined : `${endpoint.replace(/\/+$/u, "")}/v1`;
  return validateModel(model, { type: "anthropic", apiKey, baseUrl });
}

function codexModel(settings: Record<string, unknown>, auth: Record<string, unknown>): ImportedModel | null | undefined {
  const model = string(settings.model);
  if (model === undefined && settings.model_provider === undefined) return undefined;
  if (!model || settings.profile !== undefined) return null;
  const name = string(settings.model_provider) ?? "openai";
  const providers = isRecord(settings.model_providers) ? settings.model_providers : {};
  const provider = isRecord(providers[name]) ? providers[name] : {};
  if (name !== "openai" && !Object.hasOwn(providers, name)) return null;
  if (provider.env_http_headers !== undefined || provider.http_headers !== undefined || provider.experimental_bearer_token !== undefined || provider.experimental_bearer_token_command !== undefined) return null;
  const wireApi = string(provider.wire_api) ?? "responses";
  if (wireApi !== "responses" && wireApi !== "chat") return null;
  const apiKeyEnv = string(provider.env_key);
  const requiresApiKey = provider.requires_openai_auth !== false;
  const apiKey = (auth.auth_mode === undefined || auth.auth_mode === "apikey") && auth.tokens === undefined ? string(auth.OPENAI_API_KEY) : undefined;
  if (requiresApiKey && !apiKeyEnv && !apiKey) return null;
  const baseUrl = string(provider.base_url);
  if (name !== "openai" && !baseUrl) return null;
  return validateModel(model, { type: name === "openai" && !baseUrl ? "openai" : "openai-compatible",
    protocol: "openai-compatible", baseUrl, apiKey: apiKeyEnv ? undefined : apiKey, apiKeyEnv,
    requiresApiKey, apiBackend: wireApi === "responses" ? "responses" : "chat_completions" });
}

function validateModel(model: string, provider: unknown): ImportedModel | null {
  const validated = configSchema.safeParse({ ...defaultConfig, providers: { ...defaultConfig.providers, imported: provider },
    models: { ...defaultConfig.models, imported: { provider: "imported", model } } });
  return validated.success ? { model, provider: validated.data.providers.imported! } : null;
}

function mapMcpServer(source: ConfigurationImportSource, raw: unknown): McpServer | undefined {
  if (!isRecord(raw)) return undefined;
  const allowed = source === "claude" ? ["type", "command", "args", "env", "cwd", "url", "headers", "enabled", "description"]
    : ["command", "args", "env", "cwd", "url", "http_headers", "enabled", "description"];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || (string(raw.cwd) !== undefined && !path.isAbsolute(String(raw.cwd)))) return undefined;
  const command = string(raw.command);
  const url = string(raw.url);
  if (Boolean(command) === Boolean(url)) return undefined;
  const type = raw.type;
  if (type !== undefined && !["stdio", "http", "sse"].includes(String(type))) return undefined;
  if (type === "stdio" && url || (type === "http" || type === "sse") && command) return undefined;
  if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(value => typeof value === "string"))) return undefined;
  if (raw.env !== undefined && !stringRecord(raw.env)) return undefined;
  const headers = source === "codex" ? raw.http_headers : raw.headers;
  if (headers !== undefined && !stringRecord(headers)) return undefined;
  const id = randomUUID();
  const credentialRefs = {
    env: stringRecord(raw.env) ? Object.fromEntries(Object.keys(raw.env).map(key => [key, `mcp:${id}:env:${encodeURIComponent(key)}`])) : undefined,
    headers: stringRecord(headers) ? Object.fromEntries(Object.keys(headers).map(key => [key, `mcp:${id}:headers:${encodeURIComponent(key)}`])) : undefined
  };
  const value = { id, credentialRefs, type: command ? "stdio" : "http", transportProtocol: type === "sse" ? "sse" : url ? "streamable-http" : undefined,
    command, args: raw.args ?? [], env: raw.env, cwd: string(raw.cwd), url, headers, enabled: false };
  const parsed = configSchema.safeParse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { imported: value } } });
  return parsed.success ? parsed.data.extensions.mcp.imported : undefined;
}

async function readSource(home: string, relative: string): Promise<Buffer | undefined> {
  const file = path.join(home, relative);
  const parent = path.dirname(file);
  let beforeParent: Stats;
  let before: Stats;
  try {
    beforeParent = await fs.lstat(parent);
    if (!beforeParent.isDirectory() || beforeParent.isSymbolicLink() || await fs.realpath(parent) !== parent) throw new Error("unsafe parent");
    before = await fs.lstat(file);
  } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxSourceBytes) throw new Error("unsafe source");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat();
    if (!sameFile(initial, before)) throw new Error("source changed");
    const buffer = Buffer.alloc(maxSourceBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxSourceBytes) throw new Error("source too large");
    const final = await handle.stat();
    const after = await fs.lstat(file);
    const afterParent = await fs.lstat(parent);
    if (!sameFile(final, initial) || !sameFile(after, initial) || final.size !== length
      || afterParent.isSymbolicLink() || !afterParent.isDirectory() || afterParent.dev !== beforeParent.dev || afterParent.ino !== beforeParent.ino
      || await fs.realpath(parent) !== parent) throw new Error("source changed");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.isFile() && !a.isSymbolicLink() && a.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function entries(value: unknown): Array<[string, unknown]> { return isRecord(value) ? Object.entries(value) : []; }
function stringRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every(entry => typeof entry === "string"); }
function unsafeName(name: string): boolean { return ["__proto__", "prototype", "constructor"].includes(name) || !name || /[\u0000-\u001f\u007f]/u.test(name); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function credentialValues(documents: Record<string, unknown>[]): string[] {
  const values: string[] = [];
  const visit = (value: unknown, credential = false): void => {
    if (typeof value === "string") { if (credential && value) values.push(value); return; }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, credential || /^(env|headers|http_headers|env_http_headers|tokens)$/u.test(key) || /key|token|secret/i.test(key));
  };
  documents.forEach(document => visit(document));
  return values;
}
function safeLabel(name: string, secrets: string[]): string {
  let label = name;
  for (const secret of secrets) label = label.split(secret).join("[隐藏]");
  return label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 80) || "未命名服务";
}
