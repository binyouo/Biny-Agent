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
import { loadSubagentDefinitions } from "../extensions/agents.js";
import { activeSessionEventsForPath, activeSessionMessageIds, sessionMessageTree } from "./messageTree.js";
import { sessionIdFromFile } from "./store.js";
import { validateDateReferenceRange, type DateReferenceRange } from "./dateReference.js";
import type { SessionEvent } from "./events.js";
import { LocalReferenceGraph } from "./referenceGraph.js";
import { redactSensitiveValue } from "../utils/secrets.js";

export type LocalReferenceKind = "date" | "project" | "file" | "thread" | "message" | "memory" | "snippet" | "scratch"
  | "skill" | "agent" | "mcp" | "model" | "provider" | "tool" | "tool-call" | "task" | "cron" | "crystal" | "bundle" | "mission" | "plan";
export type ParsedLocalReference =
  | { kind: "date"; range: DateReferenceRange }
  | { kind: Exclude<LocalReferenceKind, "date" | "message" | "tool-call">; id: string }
  | { kind: "message" | "tool-call"; threadId: string; id: string };
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
  skill: "技能", agent: "子代理", mcp: "MCP", model: "模型", provider: "服务商", tool: "工具", "tool-call": "工具调用", task: "任务", cron: "定时任务",
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
  if (kind === "thread" && raw.length === 3 && raw[1] === "tool") {
    return { kind: "tool-call", threadId: segment(raw[0]!), id: segment(raw[2]!) };
  }
  if (kind === "date" && raw.length === 3) {
    let timeZone: string;
    try { timeZone = decodeURIComponent(raw[2]!); } catch { throw new Error("Invalid reference encoding."); }
    if (!timeZone || timeZone.length > 100 || /[\u0000-\u001f\\%]/u.test(timeZone)) throw new Error("Invalid reference time zone.");
    return { kind: "date", range: validateDateReferenceRange({ startDate: segment(raw[0]!), endDate: segment(raw[1]!), timeZone }) };
  }
  if (kind !== undefined && kind in labels && kind !== "date" && kind !== "message" && kind !== "tool-call" && raw.length >= 1) {
    if (kind !== "file" && raw.length !== 1) throw new Error("Invalid reference URI.");
    return { kind: kind as Exclude<LocalReferenceKind, "date" | "message" | "tool-call">, id: raw.map(segment).join("/") };
  }
  throw new Error("Unsupported reference kind.");
}

export function localReferenceUri(reference: ParsedLocalReference): string {
  if (reference.kind === "date") {
    validateDateReferenceRange(reference.range);
    return `biny://date/${encoded(reference.range.startDate)}/${encoded(reference.range.endDate)}/${encoded(reference.range.timeZone)}`;
  }
  if (reference.kind === "message" || reference.kind === "tool-call") {
    segment(encoded(reference.threadId)); segment(encoded(reference.id));
    return `biny://thread/${encoded(reference.threadId)}/${reference.kind === "message" ? "message" : "tool"}/${encoded(reference.id)}`;
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

function visibleToolCalls(events: SessionEvent[], threadId: string, projectId: string): LocalReferenceResult[] {
  const active = activeSessionEventsForPath(events);
  const results = new Map<string, Extract<SessionEvent, { type: "tool_result" }>>();
  for (const event of active) if (event.type === "tool_result" && !event.auditOnly && event.toolCallId) {
    results.set(event.toolCallId, event);
  }
  return active.flatMap((event) => {
    if (event.type !== "tool_call" || event.auditOnly || !event.toolCallId) return [];
    const result = results.get(event.toolCallId);
    const content = JSON.stringify({ tool: event.tool, args: redactSensitiveValue(event.args), result: redactSensitiveValue(result?.result),
      executionStatus: result?.executionStatus ?? "pending" }).slice(0, 64 * 1024);
    return [{ kind: "tool-call" as const,
      uri: localReferenceUri({ kind: "tool-call", threadId, id: event.toolCallId }), label: event.tool.slice(0, 80),
      content, projectId, threadId }];
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

  private async sessionFiles(project: LocalReferenceProject): Promise<Array<{ id: string; file: string }>> {
    const directory = projectSessionsDir(project.path, { env: { ...process.env, BINY_AGENT_DIR: this.root } });
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error("Project session storage is not a real directory.");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const rows: Array<{ id: string; file: string }> = [];
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        // 仅在当前项目目录内枚举；符号链接和目录替换不能引入其他项目内容。
        if (entry.isSymbolicLink()) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (await realpath(file) === file) await walk(file);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (await realpath(file) !== file || !(await lstat(file)).isFile()) continue;
        rows.push({ id: sessionIdFromFile(file), file });
      }
    };
    await walk(directory);
    return rows.sort((left, right) => left.file.localeCompare(right.file));
  }

  private async sessions(project: LocalReferenceProject): Promise<Array<{ id: string; events: SessionEvent[] }>> {
    const rows: Array<{ id: string; events: SessionEvent[] }> = [];
    for (const { id, file } of await this.sessionFiles(project)) {
      const events: SessionEvent[] = [];
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as SessionEvent); } catch { break; }
      }
      rows.push({ id, events });
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
    if (!["thread", "message", "tool-call"].includes(ref.kind)) {
      const existing = (await this.existingEntries(projectId, ref.kind)).find((item) => item.uri === uri);
      if (!existing) throw new Error("Reference object is not available.");
      return existing;
    }
    const threadId = ref.kind === "message" || ref.kind === "tool-call" ? ref.threadId : ref.id;
    if (ref.kind === "thread") {
      if (!(await this.sessionFiles(project)).some((item) => item.id === threadId)) throw new Error("Conversation is not available.");
      return { kind: "thread", uri, label: threadId, content: threadId, projectId, threadId };
    }
    const session = (await this.sessions(project)).find((item) => item.id === threadId);
    if (!session) throw new Error("Conversation is not available.");
    if (ref.kind === "tool-call") {
      const call = visibleToolCalls(session.events, threadId, projectId).find((item) => item.uri === uri);
      if (!call) throw new Error("Tool call is not available.");
      return call;
    }
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
    let pinned: LocalReferenceResult[] = [];
    const pinGraph = new LocalReferenceGraph(this.root, this);
    try {
      pinned = (await pinGraph.pins(projectId, limit)).filter((item) => (!kind || item.kind === kind) && matches(item.label));
      results.push(...pinned);
    }
    finally { pinGraph.close(); }
    if (!kind || kind === "date") {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
      const today = `${part("year")}-${part("month")}-${part("day")}`;
      const addDays = (day: string, count: number): string => {
        const date = new Date(`${day}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + count);
        return date.toISOString().slice(0, 10);
      };
      const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
      const weekStart = addDays(today, -((weekday + 6) % 7));
      const nextMonday = addDays(weekStart, 7);
      const presets = [
        { label: "今天", startDate: today, endDate: addDays(today, 1) },
        { label: "本周", startDate: weekStart, endDate: nextMonday },
        { label: "下周一", startDate: nextMonday, endDate: addDays(nextMonday, 1) }
      ];
      for (const preset of presets) if (!needle || matches(preset.label)) {
        const range = { startDate: preset.startDate, endDate: preset.endDate, timeZone };
        results.push({ kind: "date", uri: localReferenceUri({ kind: "date", range }), label: preset.label,
          content: JSON.stringify(range), projectId });
      }
      const day = needle;
      if (/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
        const next = new Date(`${day}T00:00:00.000Z`);
        if (!Number.isNaN(next.getTime()) && next.toISOString().slice(0, 10) === day) {
          const range = { startDate: day, endDate: addDays(day, 1), timeZone };
          results.push({ kind: "date", uri: localReferenceUri({ kind: "date", range }), label: day,
            content: JSON.stringify(range), projectId });
        }
      }
    }
    if ((!kind || kind === "project") && matches(project.name)) {
      results.push({ kind: "project", uri: localReferenceUri({ kind: "project", id: project.id }), label: project.name, content: project.path, projectId });
    }
    if (!kind || kind === "file") {
      let fileMatches = 0;
      const walk = async (directory: string, prefix = "", depth = 0): Promise<void> => {
        if (depth > 8 || fileMatches >= limit) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          if (!needle && !kind && entry.isDirectory() && ["out", "dist", "release", "coverage", ".next"].includes(entry.name)) continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
          else if (entry.isFile() && matches(relative)) {
            results.push({ kind: "file", uri: localReferenceUri({ kind: "file", id: relative }),
              label: relative, content: relative, projectId });
            fileMatches += 1;
          }
          if (fileMatches >= limit) break;
        }
      };
      await walk(project.path);
    }
    if (!kind || kind === "thread" || kind === "message" || kind === "tool-call") {
      let threadMatches = 0;
      let messageMatches = 0;
      let toolCallMatches = 0;
      const sessions = kind === "thread"
        ? (await this.sessionFiles(project)).map((item) => ({ id: item.id, events: [] as SessionEvent[] }))
        : await this.sessions(project);
      for (const session of sessions) {
        if ((!kind || kind === "thread") && threadMatches < limit && matches(session.id)) {
          results.push({ kind: "thread", uri: localReferenceUri({ kind: "thread", id: session.id }),
            label: session.id, content: session.id, projectId, threadId: session.id });
          threadMatches += 1;
        }
        if (!kind || kind === "message") for (const message of visibleMessages(session.events)) {
          if (messageMatches < limit && matches(message.content)) {
            results.push({ kind: "message",
            uri: localReferenceUri({ kind: "message", threadId: session.id, id: message.slotId }),
            label: message.content.slice(0, 80), content: message.content, projectId, threadId: session.id, messageId: message.messageId });
            messageMatches += 1;
          }
        }
        if (!kind || kind === "tool-call") for (const call of visibleToolCalls(session.events, session.id, projectId)) {
          if (toolCallMatches < limit && (matches(call.label) || matches(call.content))) {
            results.push(call);
            toolCallMatches += 1;
          }
        }
        if ((kind === "thread" && threadMatches >= limit) || (kind === "message" && messageMatches >= limit)
          || (kind === "tool-call" && toolCallMatches >= limit)
          || (!kind && threadMatches >= limit && messageMatches >= limit && toolCallMatches >= limit)) break;
      }
    }
    if (!kind || kind === "memory") {
      const store = new MemoryStorage(project.path, { agentDir: this.root });
      let memoryMatches = 0;
      try { for (const entry of (await store.listEntries({ limit: 1000 })).entries) {
        if (matches(entry.content)) results.push({ kind: "memory", uri: localReferenceUri({ kind: "memory", id: entry.id }),
          label: entry.content.slice(0, 80), content: entry.content, projectId });
        if (matches(entry.content)) memoryMatches += 1;
        if (memoryMatches >= limit) break;
      } } finally { store.close(); }
    }
    if (!kind || ["skill", "agent", "mcp", "model", "provider", "tool", "task", "cron", "crystal", "bundle", "mission", "plan"].includes(kind)) {
      results.push(...(await this.existingEntries(projectId, kind)).filter((item) => matches(item.label) || matches(item.content)));
    }
    if (!kind || kind === "snippet" || kind === "scratch") {
      const graph = new LocalReferenceGraph(this.root, this);
      try {
        for (const storedKind of ["snippet", "scratch"] as const) {
          if (kind && kind !== storedKind) continue;
          results.push(...await graph.searchStored(needle, projectId, storedKind, limit));
        }
      } finally { graph.close(); }
    }
    const unique = [...new Map(results.map((item) => [item.uri, item])).values()];
    if (kind) return unique.slice(0, limit);
    const visiblePins = pinned.slice(0, Math.min(8, limit));
    const pinUris = new Set(visiblePins.map((item) => item.uri));
    // 空查询也要给每个实际有对象的种类一次展示机会，不能让文件占满总上限。
    const groups = new Map<LocalReferenceKind, LocalReferenceResult[]>();
    for (const item of unique) if (!pinUris.has(item.uri)) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
    const ordered = [...groups.keys()].sort((left, right) => localReferenceKinds.findIndex((item) => item.kind === left)
      - localReferenceKinds.findIndex((item) => item.kind === right));
    const balanced: LocalReferenceResult[] = [];
    while (balanced.length < limit - visiblePins.length && ordered.length) {
      for (const current of [...ordered]) {
        const next = groups.get(current)?.shift();
        if (next) balanced.push(next);
        else ordered.splice(ordered.indexOf(current), 1);
        if (balanced.length >= limit - visiblePins.length) break;
      }
    }
    return [...visiblePins, ...balanced.sort((left, right) => localReferenceKinds.findIndex((item) => item.kind === left.kind)
      - localReferenceKinds.findIndex((item) => item.kind === right.kind))];
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
      result.push({ kind: entryKind, uri: localReferenceUri({ kind: entryKind as Exclude<LocalReferenceKind, "date" | "message" | "tool-call">, id }),
        label: label.slice(0, 80), content: content.slice(0, 64 * 1024), projectId });
    };
    if (!kind || ["provider", "model", "mcp", "skill", "agent"].includes(kind)) {
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
      if ((!kind || kind === "agent") && config.extensions.subagent.enabled) {
        const definitions = await loadSubagentDefinitions({ workspaceRoot: project.path,
          projectPaths: config.extensions.subagent.agentPaths });
        for (const definition of definitions) add("agent", definition.name, definition.name,
          `${definition.description}\n${definition.prompt}`);
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
      let entries: Awaited<ReturnType<NonNullable<typeof this.runtimeEntries>>>;
      try { entries = await this.runtimeEntries(projectId); }
      catch (cause) {
        if (kind) throw cause;
        entries = [];
      }
      for (const entry of entries) {
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
