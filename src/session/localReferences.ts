/** 本地 @ 引用的 URI、真实对象查找与权限边界；Session 和项目文件仍是权威来源。 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { MemoryStorage } from "../agent/context/memoryStorage.js";
import { CrystalStorage } from "../agent/context/crystalStorage.js";
import { globalAgentDir, projectSessionsDir } from "../config/paths.js";
import { createFileConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import { loadSkills } from "../extensions/skills.js";
import { activeSessionMessageIds, sessionMessageTree } from "./messageTree.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import { validateDateReferenceRange, type DateReferenceRange } from "./dateReference.js";
import type { SessionEvent } from "./events.js";
import { LocalReferenceGraph } from "./referenceGraph.js";

export type LocalReferenceKind = "date" | "project" | "file" | "thread" | "message" | "memory" | "snippet" | "scratch"
  | "skill" | "mcp" | "model" | "provider" | "tool" | "task" | "cron" | "crystal" | "bundle" | "mission" | "plan";
export type ParsedLocalReference =
  | { kind: "date"; range: DateReferenceRange }
  | { kind: Exclude<LocalReferenceKind, "date" | "message">; id: string }
  | { kind: "message"; threadId: string; id: string };
export interface LocalReferenceResult {
  kind: LocalReferenceKind;
  uri: string;
  label: string;
  content: string;
  projectId?: string;
  threadId?: string;
  messageId?: string;
}
export interface LocalReferenceProject { id: string; path: string; name: string }

const labels: Record<LocalReferenceKind, string> = {
  date: "日期", project: "项目", file: "文件", thread: "会话", message: "消息", memory: "记忆", snippet: "片段", scratch: "临时引用",
  skill: "技能", mcp: "MCP", model: "模型", provider: "服务商", tool: "工具", task: "任务", cron: "定时任务",
  crystal: "结晶", bundle: "结晶包", mission: "目标", plan: "计划"
};
export const localReferenceKinds = Object.entries(labels).map(([kind, label]) => ({ kind: kind as LocalReferenceKind, label }));

function segment(value: string): string {
  if (!value || value.length > 2048 || /[\\/\u0000-\u001f]/u.test(value) || value === "." || value === "..") throw new Error("Invalid reference identifier.");
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("Invalid reference encoding."); }
  if (!decoded || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f]/u.test(decoded) || decoded.includes("%")) {
    throw new Error("Invalid reference identifier.");
  }
  return decoded;
}

function encoded(value: string): string { return encodeURIComponent(value); }

export function parseLocalReferenceUri(uri: string): ParsedLocalReference {
  if (uri.length > 4096 || !uri.startsWith("biny://") || /[?#]/u.test(uri)) throw new Error("Invalid reference URI.");
  const [kind, ...raw] = uri.slice(7).split("/");
  if (kind === "thread" && raw.length === 3 && raw[1] === "message") {
    return { kind: "message", threadId: segment(raw[0]!), id: segment(raw[2]!) };
  }
  if (kind === "date" && raw.length === 3) {
    let timeZone: string;
    try { timeZone = decodeURIComponent(raw[2]!); } catch { throw new Error("Invalid reference encoding."); }
    if (!timeZone || timeZone.length > 100 || /[\u0000-\u001f\\%]/u.test(timeZone)) throw new Error("Invalid reference time zone.");
    return { kind: "date", range: validateDateReferenceRange({ startDate: segment(raw[0]!), endDate: segment(raw[1]!), timeZone }) };
  }
  if (kind !== undefined && kind in labels && kind !== "date" && kind !== "message" && raw.length >= 1) {
    if (kind !== "file" && raw.length !== 1) throw new Error("Invalid reference URI.");
    return { kind: kind as Exclude<LocalReferenceKind, "date" | "message">, id: raw.map(segment).join("/") };
  }
  throw new Error("Unsupported reference kind.");
}

export function localReferenceUri(reference: ParsedLocalReference): string {
  if (reference.kind === "date") {
    validateDateReferenceRange(reference.range);
    return `biny://date/${encoded(reference.range.startDate)}/${encoded(reference.range.endDate)}/${encoded(reference.range.timeZone)}`;
  }
  if (reference.kind === "message") {
    segment(encoded(reference.threadId)); segment(encoded(reference.id));
    return `biny://thread/${encoded(reference.threadId)}/message/${encoded(reference.id)}`;
  }
  const parts = reference.id.split("/");
  if (reference.kind !== "file" && parts.length !== 1) throw new Error("Invalid reference identifier.");
  for (const part of parts) segment(encoded(part));
  return `biny://${reference.kind}/${parts.map(encoded).join("/")}`;
}

export function formatLocalReference(label: string, uri: string): string {
  parseLocalReferenceUri(uri);
  if (!label.trim() || label.length > 80 || /[\]\n\r]/u.test(label)) throw new Error("Invalid reference label.");
  return `@[${label}](${uri})`;
}

function textOf(event: SessionEvent): string | undefined {
  if (event.type === "user_message") return event.auditOnly ? undefined : event.content;
  if (event.type === "agent_message") return typeof event.message.content === "string" ? event.message.content : undefined;
  return undefined;
}

function visibleMessages(events: SessionEvent[]): Array<{ slotId: string; messageId: string; content: string }> {
  const nodes = sessionMessageTree(events);
  const active = activeSessionMessageIds(events);
  const hasParentLinks = nodes.some((node) => node.parentId !== undefined);
  const selected = new Map<string, string>();
  for (const node of nodes) if (node.slotId) selected.set(node.slotId, node.id);
  for (const event of events) if (event.type === "message_version_selected") selected.set(event.slotId, event.messageId);
  return nodes.flatMap((node) => {
    if (!node.slotId || selected.get(node.slotId) !== node.id || (hasParentLinks && !active.has(node.id))) return [];
    const content = textOf(events[node.eventIndex]!);
    return content === undefined ? [] : [{ slotId: node.slotId, messageId: node.id, content }];
  });
}

export class LocalReferenceService {
  private readonly root: string;
  private readonly projects: LocalReferenceProject[];
  private readonly loadConfig: (workspaceRoot: string) => Promise<AgentConfig>;
  private readonly runtimeEntries?: (projectId: string) => Promise<Array<Pick<LocalReferenceResult, "kind" | "label" | "content"> & { id: string }>>;
  constructor(options: { root?: string; projects: LocalReferenceProject[];
    loadConfig?: (workspaceRoot: string) => Promise<AgentConfig>;
    runtimeEntries?: (projectId: string) => Promise<Array<Pick<LocalReferenceResult, "kind" | "label" | "content"> & { id: string }>> }) {
    this.root = options.root ?? globalAgentDir();
    this.projects = options.projects;
    this.loadConfig = options.loadConfig ?? (async (workspaceRoot) => await createFileConfigStore(workspaceRoot).load());
    this.runtimeEntries = options.runtimeEntries;
  }

  kinds(): typeof localReferenceKinds { return localReferenceKinds; }

  private project(id: string): LocalReferenceProject {
    const project = this.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project is not available.");
    return project;
  }

  private async sessions(project: LocalReferenceProject): Promise<Array<{ id: string; events: SessionEvent[] }>> {
    const directory = projectSessionsDir(project.path, { env: { ...process.env, BINY_AGENT_DIR: this.root } });
    const files = await listAllSessionFiles(this.root);
    const rows: Array<{ id: string; events: SessionEvent[] }> = [];
    for (const file of files) {
      const canonical = await realpath(file);
      if (!canonical.startsWith(`${directory}${path.sep}`) || !(await lstat(file)).isFile()) continue;
      const events: SessionEvent[] = [];
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as SessionEvent); } catch { break; }
      }
      rows.push({ id: sessionIdFromFile(file), events });
    }
    return rows;
  }

  async resolve(uri: string, projectId: string): Promise<LocalReferenceResult> {
    const project = this.project(projectId);
    const ref = parseLocalReferenceUri(uri);
    if (ref.kind === "snippet" || ref.kind === "scratch") {
      const graph = new LocalReferenceGraph(this.root, this);
      try { return await graph.resolve(uri, projectId); } finally { graph.close(); }
    }
    if (ref.kind === "date") return { kind: "date", uri, label: `${ref.range.startDate}–${ref.range.endDate}`,
      content: JSON.stringify(ref.range), projectId };
    if (ref.kind === "project") {
      if (ref.id !== project.id) throw new Error("Project is not available.");
      return { kind: "project", uri, label: project.name, content: project.path, projectId };
    }
    if (ref.kind === "file") {
      const root = await realpath(project.path);
      const target = await realpath(path.join(root, ref.id));
      if (!target.startsWith(`${root}${path.sep}`) || !(await lstat(target)).isFile()) throw new Error("File is not available.");
      const stat = await lstat(target);
      if (stat.size > 64 * 1024) throw new Error("Reference file exceeds content budget.");
      const content = await readFile(target, "utf8");
      return { kind: "file", uri, label: ref.id, content, projectId };
    }
    if (ref.kind === "memory") {
      const store = new MemoryStorage(project.path, { agentDir: this.root });
      try {
        const entry = (await store.listEntries()).entries.find((item) => item.id === ref.id);
        if (!entry) throw new Error("Memory is not available.");
        return { kind: "memory", uri, label: entry.content.slice(0, 80), content: entry.content, projectId };
      } finally { store.close(); }
    }
    if (!["thread", "message"].includes(ref.kind)) {
      const existing = (await this.existingEntries(projectId, ref.kind)).find((item) => item.uri === uri);
      if (!existing) throw new Error("Reference object is not available.");
      return existing;
    }
    const threadId = ref.kind === "message" ? ref.threadId : ref.id;
    const session = (await this.sessions(project)).find((item) => item.id === threadId);
    if (!session) throw new Error("Conversation is not available.");
    if (ref.kind === "thread") return { kind: "thread", uri, label: threadId, content: threadId, projectId, threadId };
    const message = visibleMessages(session.events).find((item) => item.slotId === ref.id);
    if (!message) throw new Error("Message is not available.");
    return { kind: "message", uri, label: message.content.slice(0, 80), content: message.content,
      projectId, threadId, messageId: message.messageId };
  }

  async search(query: string, projectId: string, kind?: LocalReferenceKind, limit = 30,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<LocalReferenceResult[]> {
    const project = this.project(projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || query.length > 200) throw new Error("Invalid reference search.");
    const needle = query.trim().toLocaleLowerCase();
    const matches = (value: string): boolean => !needle || value.toLocaleLowerCase().includes(needle);
    const results: LocalReferenceResult[] = [];
    const pinGraph = new LocalReferenceGraph(this.root, this);
    try { results.push(...(await pinGraph.pins(projectId, limit)).filter((item) => (!kind || item.kind === kind) && matches(item.label))); }
    finally { pinGraph.close(); }
    if (!kind || kind === "date") {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
      const day = needle || `${part("year")}-${part("month")}-${part("day")}`;
      if (/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
        const next = new Date(`${day}T00:00:00.000Z`);
        if (!Number.isNaN(next.getTime()) && next.toISOString().slice(0, 10) === day) {
          next.setUTCDate(next.getUTCDate() + 1);
          const range = { startDate: day, endDate: next.toISOString().slice(0, 10), timeZone };
          results.push({ kind: "date", uri: localReferenceUri({ kind: "date", range }), label: day,
            content: JSON.stringify(range), projectId });
        }
      }
    }
    if ((!kind || kind === "project") && matches(project.name)) {
      results.push({ kind: "project", uri: localReferenceUri({ kind: "project", id: project.id }), label: project.name, content: project.path, projectId });
    }
    if (!kind || kind === "file") {
      const walk = async (directory: string, prefix = "", depth = 0): Promise<void> => {
        if (depth > 8 || results.length >= limit) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
          else if (entry.isFile() && matches(relative)) results.push({ kind: "file", uri: localReferenceUri({ kind: "file", id: relative }),
            label: relative, content: relative, projectId });
          if (results.length >= limit) break;
        }
      };
      await walk(project.path);
    }
    if (!kind || kind === "thread" || kind === "message") {
      for (const session of await this.sessions(project)) {
        if ((!kind || kind === "thread") && matches(session.id)) results.push({ kind: "thread",
          uri: localReferenceUri({ kind: "thread", id: session.id }), label: session.id, content: session.id, projectId, threadId: session.id });
        if (!kind || kind === "message") for (const message of visibleMessages(session.events)) {
          if (matches(message.content)) results.push({ kind: "message",
            uri: localReferenceUri({ kind: "message", threadId: session.id, id: message.slotId }),
            label: message.content.slice(0, 80), content: message.content, projectId, threadId: session.id, messageId: message.messageId });
        }
        if (results.length >= limit) break;
      }
    }
    if (!kind || kind === "memory") {
      const store = new MemoryStorage(project.path, { agentDir: this.root });
      try { for (const entry of (await store.listEntries({ limit: 1000 })).entries) {
        if (matches(entry.content)) results.push({ kind: "memory", uri: localReferenceUri({ kind: "memory", id: entry.id }),
          label: entry.content.slice(0, 80), content: entry.content, projectId });
        if (results.length >= limit) break;
      } } finally { store.close(); }
    }
    if (!kind || ["skill", "mcp", "model", "provider", "tool", "task", "cron", "crystal", "bundle", "mission", "plan"].includes(kind)) {
      results.push(...(await this.existingEntries(projectId, kind)).filter((item) => matches(item.label) || matches(item.content)).slice(0, limit));
    }
    if (results.length < limit && (!kind || kind === "snippet" || kind === "scratch")) {
      const graph = new LocalReferenceGraph(this.root, this);
      try {
        for (const storedKind of ["snippet", "scratch"] as const) {
          if (kind && kind !== storedKind) continue;
          results.push(...await graph.searchStored(needle, projectId, storedKind, limit - results.length));
          if (results.length >= limit) break;
        }
      } finally { graph.close(); }
    }
    return [...new Map(results.map((item) => [item.uri, item])).values()].slice(0, limit);
  }

  async allMessages(projectId: string): Promise<LocalReferenceResult[]> {
    const project = this.project(projectId);
    return (await this.sessions(project)).flatMap((session) => visibleMessages(session.events).map((message) => ({
      kind: "message" as const, uri: localReferenceUri({ kind: "message", threadId: session.id, id: message.slotId }),
      label: message.content.slice(0, 80), content: message.content, projectId, threadId: session.id, messageId: message.messageId
    })));
  }

  async referenceForMessage(threadId: string, messageId: string, projectId: string): Promise<LocalReferenceResult> {
    const message = (await this.allMessages(projectId)).find((item) => item.threadId === threadId && item.messageId === messageId);
    if (!message) throw new Error("Message is not available on the active path.");
    return message;
  }

  private async existingEntries(projectId: string, kind?: LocalReferenceKind): Promise<LocalReferenceResult[]> {
    const project = this.project(projectId);
    const result: LocalReferenceResult[] = [];
    const add = (entryKind: LocalReferenceKind, id: string, label: string, content: string): void => {
      result.push({ kind: entryKind, uri: localReferenceUri({ kind: entryKind as Exclude<LocalReferenceKind, "date" | "message">, id }),
        label: label.slice(0, 80), content: content.slice(0, 64 * 1024), projectId });
    };
    if (!kind || ["provider", "model", "mcp", "skill"].includes(kind)) {
      const config = await this.loadConfig(project.path);
      if (!kind || kind === "provider") for (const [alias, provider] of Object.entries(config.providers)) {
        add("provider", alias, provider.displayName ?? alias, `${alias} (${provider.type})`);
      }
      if (!kind || kind === "model") for (const [alias, model] of Object.entries(config.models)) {
        add("model", alias, model.displayName ?? alias, `${model.provider}/${model.model}`);
      }
      if (!kind || kind === "mcp") for (const name of Object.keys(config.extensions.mcp)) add("mcp", name, name, name);
      if (!kind || kind === "skill") {
        const bundle = await loadSkills({ workspaceRoot: project.path, projectPaths: config.extensions.skills });
        for (const skill of bundle.skills) add("skill", skill.ref, skill.name, skill.description);
      }
    }
    if (!kind || kind === "crystal" || kind === "bundle") {
      const store = new CrystalStorage({ agentDir: this.root });
      await store.initialize();
      try {
        if (!kind || kind === "crystal") for (const crystal of store.listCrystals()) {
          add("crystal", crystal.id, crystal.name, JSON.stringify({ name: crystal.name, stage: crystal.stage, checklist: crystal.checklist }));
        }
        if (!kind || kind === "bundle") for (const bundle of store.listBundles()) {
          add("bundle", bundle.id, bundle.name ?? bundle.id, JSON.stringify({ name: bundle.name, threadId: bundle.threadId, anchorIds: bundle.anchorIds }));
        }
      } finally { store.close(); }
    }
    if (this.runtimeEntries && (!kind || ["tool", "task", "cron", "mission", "plan"].includes(kind))) {
      for (const entry of await this.runtimeEntries(projectId)) {
        if (kind && entry.kind !== kind) continue;
        if (!["tool", "task", "cron", "mission", "plan"].includes(entry.kind)) continue;
        add(entry.kind, entry.id, entry.label, entry.content);
      }
    }
    return result;
  }
}

/** CLI 和 Desktop 使用同一项目 ID，不把路径当作引用身份。 */
export function localReferenceProjectId(projectPath: string): string {
  return createHash("sha256").update(path.resolve(projectPath)).digest("hex").slice(0, 20);
}

/** 只展开用户明确插入的引用；解析失败不猜来源，正文作为不可信数据且受字符预算限制。 */
export async function localReferenceContext(input: string, service: LocalReferenceService, projectId: string, maxChars = 8_000): Promise<string> {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 30_000) throw new Error("Invalid reference context budget.");
  const references = [...input.matchAll(/@\[[^\]\n]{1,80}\]\((biny:\/\/[^\s)]+)\)/gu)].slice(0, 8);
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of references) {
    const uri = match[1]!;
    if (seen.has(uri)) continue;
    seen.add(uri);
    try {
      const result = await service.resolve(uri, projectId);
      const remaining = maxChars - blocks.join("\n").length;
      if (remaining < 30) break;
      blocks.push(`[${result.kind}] ${uri}\n${result.content.slice(0, Math.max(0, remaining - uri.length - result.kind.length - 5))}`);
    } catch { /* 失效或越权引用不补入正文，原消息仍保留。 */ }
  }
  return blocks.join("\n").slice(0, maxChars);
}

export { LocalReferenceGraph } from "./referenceGraph.js";
