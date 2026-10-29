/**
 * 具名子代理定义模块。
 *
 * 每个定义是一个带 YAML frontmatter 的 markdown 文件：frontmatter 提供
 * name/description/tools/model/runtime/isolation 元数据，正文即该子代理的附加 system prompt。
 * 项目定义放在 extensions.subagent.agentPaths（默认 .biny/agents），全局定义放在
 * ~/.config/biny/agents，项目级同名覆盖全局。定义在每次委派时重新读取，
 * 允许会话期间编辑生效。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";

const maxAgentCount = 16;
const maxAgentFileBytes = 32 * 1024;
const maxAgentDescriptionChars = 300;
const maxAgentToolCount = 32;

export type SubagentDefinitionScope = "project" | "global";

export interface SubagentDefinition {
  name: string;
  description: string;
  /** 定义正文，作为子代理的附加 system prompt。 */
  prompt: string;
  /** frontmatter tools 声明的工具子集；省略表示使用全局 allowedTools。 */
  tools?: string[];
  /** 内置与 ACP 使用 Biny 模型别名；直接 CLI 使用原始模型 ID。 */
  model?: string;
  providerAlias?: string;
  runtime?: "auto" | "builtin" | "codex" | "claude-code" | "acp";
  isolation?: "worktree";
  scope: SubagentDefinitionScope;
  /** 展示路径：项目定义为 workspace 相对路径，全局定义以 ~ 开头。 */
  path: string;
  filePath: string;
}

export interface LoadSubagentDefinitionsOptions {
  workspaceRoot: string;
  /** workspace 相对目录，来自 extensions.subagent.agentPaths。 */
  projectPaths: string[];
  /** 全局定义目录；默认 ~/.config/biny/agents。 */
  globalRoot?: string;
}

export async function loadSubagentDefinitions(options: LoadSubagentDefinitionsOptions): Promise<SubagentDefinition[]> {
  const canonicalWorkspace = await fs.realpath(path.resolve(options.workspaceRoot));
  const definitions: SubagentDefinition[] = [];
  const usedNames = new Set<string>();
  for (const configuredPath of options.projectPaths) {
    if (definitions.length >= maxAgentCount) break;
    const directory = await resolveProjectAgentDirectory(canonicalWorkspace, configuredPath);
    if (!directory) continue;
    await collectDefinitions(definitions, usedNames, canonicalWorkspace, directory, "project");
  }

  // 全局定义在项目定义之后加载，同名时项目级优先。全局目录异常只放弃全局定义。
  const globalRoot = options.globalRoot ?? path.join(globalConfigDir(), "agents");
  try {
    const canonicalGlobalRoot = await resolveGlobalAgentRoot(globalRoot);
    if (canonicalGlobalRoot) {
      await collectDefinitions(definitions, usedNames, canonicalGlobalRoot, canonicalGlobalRoot, "global");
    }
  } catch {
    // 共享目录里的软链/权限问题不能阻止工作区启动；项目内路径仍保持硬失败。
  }
  return definitions;
}

export function findSubagentDefinition(definitions: readonly SubagentDefinition[], name: string): SubagentDefinition | undefined {
  const requested = name.trim();
  return definitions.find((definition) => definition.name === requested)
    ?? definitions.find((definition) => definition.name.toLowerCase() === requested.toLowerCase());
}

/** system prompt 里的具名子代理元数据段（正文不进入主上下文，保持渐进披露）。 */
export function buildSubagentDefinitionsPrompt(definitions: readonly SubagentDefinition[]): string {
  if (!definitions.length) return "";
  return [
    "Named subagents (metadata only; each runs as a bounded worker in its selected runtime):",
    ...definitions.map((definition) => {
      const extras = [
        definition.scope,
        definition.runtime ? `runtime ${definition.runtime}` : "",
        definition.model ? `model ${definition.model}` : "",
        definition.providerAlias ? `provider ${definition.providerAlias}` : "",
        definition.isolation ? `isolation ${definition.isolation}` : "",
        definition.tools ? `tools ${definition.tools.join("/")}` : ""
      ].filter(Boolean).join(", ");
      return `- ${definition.name} (${extras}): ${definition.description}`;
    }),
    "Use Task with agent: \"<name>\" to delegate to a named worker; omit agent for the default worker. Delegate only work that benefits from isolation or a separate specialist."
  ].join("\n");
}

async function collectDefinitions(
  definitions: SubagentDefinition[],
  usedNames: Set<string>,
  rootPath: string,
  directory: string,
  scope: SubagentDefinitionScope
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  // 只认目录下第一层的 *.md，不递归，避免把附属文档误当定义。
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const fileName of files) {
    if (definitions.length >= maxAgentCount) return;
    const definition = await readDefinition(rootPath, path.join(directory, fileName), scope);
    if (!definition || usedNames.has(definition.name)) continue;
    usedNames.add(definition.name);
    definitions.push(definition);
  }
}

async function readDefinition(rootPath: string, filePath: string, scope: SubagentDefinitionScope): Promise<SubagentDefinition | undefined> {
  let content: string;
  try {
    content = await readBoundedRegularFile(rootPath, filePath, maxAgentFileBytes);
  } catch {
    // 单个异常定义（软链/硬链/越界/超限）直接跳过，不拖垮其余定义。
    return undefined;
  }
  return parseDefinition(content, rootPath, filePath, scope);
}

function parseDefinition(content: string, rootPath: string, filePath: string, scope: SubagentDefinitionScope): SubagentDefinition | undefined {
  const { frontmatter, body } = splitAgentFrontmatter(content);
  const name = normalizeAgentName(frontmatter.name ?? path.basename(filePath, path.extname(filePath)));
  const description = (frontmatter.description ?? "").trim();
  const prompt = body.trim();
  // 没有 description 或正文的定义视为无效。
  if (!name || !description || !prompt) return undefined;
  if (frontmatter.runtime && !parseRuntime(frontmatter.runtime)) throw new Error(`Invalid subagent runtime: ${frontmatter.runtime}`);
  if (frontmatter.isolation && frontmatter.isolation !== "worktree") throw new Error(`Invalid subagent isolation: ${frontmatter.isolation}`);
  const relative = path.relative(rootPath, filePath);
  return {
    name,
    description: truncateChars(description, maxAgentDescriptionChars),
    prompt,
    tools: parseToolList(frontmatter.tools),
    model: frontmatter.model?.trim() || undefined,
    providerAlias: frontmatter.providerAlias?.trim() || undefined,
    runtime: parseRuntime(frontmatter.runtime),
    isolation: frontmatter.isolation === "worktree" ? "worktree" : undefined,
    scope,
    path: scope === "global" ? globalDisplayPath(rootPath, relative) : relative,
    filePath
  };
}

export async function createSubagentDefinition(options: LoadSubagentDefinitionsOptions, name: string, content: string, scope: SubagentDefinitionScope): Promise<SubagentDefinition> {
  if (!name || normalizeAgentName(name) !== name) throw new Error("Agent name must use lowercase letters, digits, underscores or hyphens (1-64 characters).");
  if (Buffer.byteLength(content) > maxAgentFileBytes) throw new Error(`Subagent definition exceeds ${String(maxAgentFileBytes)} bytes.`);
  const workspace = await fs.realpath(options.workspaceRoot);
  const configured = options.projectPaths[0];
  if (scope === "project" && configured === undefined) throw new Error("No project agent directory configured.");
  const directory = scope === "global" ? options.globalRoot ?? path.join(globalConfigDir(), "agents") : path.resolve(workspace, configured!);
  if (scope === "project") {
    if (escapes(workspace, directory)) throw new Error("Subagent definition path must stay inside workspace.");
    let parent = directory;
    while (!await resolveProjectAgentDirectory(workspace, path.relative(workspace, parent))) parent = path.dirname(parent);
  }
  await fs.mkdir(directory, { recursive: true });
  const root = scope === "global" ? (await resolveGlobalAgentRoot(directory))! : (await resolveProjectAgentDirectory(workspace, configured!))!;
  const filePath = path.join(root, `${name}.md`);
  const definition = parseDefinition(content, scope === "project" ? workspace : root, filePath, scope);
  if (!definition || definition.name !== name) throw new Error("Agent definition requires a matching name, description and prompt body.");
  const existing = await loadSubagentDefinitions({ ...options, projectPaths: scope === "global" ? [] : options.projectPaths });
  if (existing.some(agent => agent.scope === scope && agent.name === name)) throw new Error(`Agent already exists: ${name}`);
  if (existing.length >= maxAgentCount && !existing.some(agent => agent.name === name)) throw new Error(`At most ${String(maxAgentCount)} agent definitions can be loaded.`);
  await fs.writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  return definition;
}

export async function deleteSubagentDefinition(options: LoadSubagentDefinitionsOptions, name: string, global = false): Promise<SubagentDefinition> {
  const definitions = await loadSubagentDefinitions({ ...options, projectPaths: global ? [] : options.projectPaths });
  const definition = findSubagentDefinition(definitions, name);
  if (!definition) throw new Error(`Unknown agent: ${name}`);
  await fs.unlink(definition.filePath);
  return definition;
}

function parseRuntime(value?: string): SubagentDefinition["runtime"] {
  if (value === "auto" || value === "builtin" || value === "codex" || value === "claude-code" || value === "acp") return value;
  return undefined;
}

interface AgentFrontmatter {
  isolation?: string;
  runtime?: string;
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  providerAlias?: string;
}

function splitAgentFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).trim() !== "---") return { frontmatter: {}, body: content };
  const closing = content.indexOf("\n---", firstLineEnd);
  if (closing === -1) return { frontmatter: {}, body: content };
  const closingLineEnd = content.indexOf("\n", closing + 1);
  const lines = content.slice(firstLineEnd + 1, closing).split("\n");
  // 只有 fence 之间全部是 "key: value" 才当 frontmatter，避免误吞以分割线开头的正文。
  if (!lines.every((line) => !line.trim() || /^\s*[A-Za-z0-9_-]+\s*:/.test(line))) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: AgentFrontmatter = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const rawKey = line.slice(0, separator).trim().toLowerCase();
    const key = rawKey === "provideralias" ? "providerAlias" : rawKey;
    if (key !== "name" && key !== "description" && key !== "tools" && key !== "model" && key !== "runtime" && key !== "isolation" && key !== "providerAlias") continue;
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (value) frontmatter[key] = value;
  }
  return { frontmatter, body: closingLineEnd === -1 ? "" : content.slice(closingLineEnd + 1) };
}

function parseToolList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tools = [...new Set(value.split(",").map((tool) => tool.trim()).filter(Boolean))].slice(0, maxAgentToolCount);
  return tools.length ? tools : undefined;
}

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function globalDisplayPath(rootPath: string, relative: string): string {
  const fromHome = path.relative(os.homedir(), rootPath);
  if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return path.join("~", fromHome, relative);
  return path.join(rootPath, relative);
}

async function resolveProjectAgentDirectory(rootPath: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(rootPath, configuredPath);
  if (escapes(rootPath, absolutePath)) throw new Error(`Subagent definition path must stay inside workspace: ${configuredPath}`);
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Subagent definition paths cannot be symbolic links: ${configuredPath}`);
    if (!stat.isDirectory()) return undefined;
    const canonical = await fs.realpath(absolutePath);
    if (canonical !== absolutePath) throw new Error(`Subagent definition paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 全局根目录允许经符号链接到达（如 macOS 的 /tmp），目录内部仍禁止软链文件。 */
async function resolveGlobalAgentRoot(globalRoot: string): Promise<string | undefined> {
  try {
    const canonical = await fs.realpath(path.resolve(globalRoot));
    const stat = await fs.lstat(canonical);
    return stat.isDirectory() ? canonical : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readBoundedRegularFile(rootPath: string, filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Subagent definition cannot be a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Subagent definition is not a file: ${filePath}`);
  if (stat.nlink !== 1n) throw new Error(`Subagent definition cannot be a hardlink: ${filePath}`);
  if (stat.size > BigInt(maxBytes)) throw new Error(`Subagent definition exceeds ${String(maxBytes)} bytes: ${filePath}`);
  const canonical = await fs.realpath(filePath);
  if (canonical !== filePath || escapes(rootPath, canonical)) {
    throw new Error(`Subagent definition escapes its root: ${filePath}`);
  }
  return await fs.readFile(filePath, "utf8");
}

function escapes(rootPath: string, target: string): boolean {
  const relative = path.relative(rootPath, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
