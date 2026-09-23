/** 桌面摘要装配：只读取已登记工作区的活动消息分支，项目确认由主进程显式执行。 */
import { z } from "zod";
import { stat } from "node:fs/promises";
import type { AgentConfigStore } from "../../../config/store.js";
import { resolveToolModel } from "../../../llm/toolModel.js";
import { readSessionEvents, readSessionSummary } from "../../../session/events.js";
import { listSessionCatalog, readSessionCatalogRecord } from "../../../session/catalog.js";
import { activeSessionMessageIds, sessionMessageTree } from "../../../session/messageTree.js";
import { publicUserMessage } from "../../../session/publicMessage.js";
import { resolveSessionFile, sessionIdFromFile } from "../../../session/store.js";
import { ThreadBriefService, type BriefThread } from "../../../session/threadBriefService.js";
import { ThreadBriefStore, threadBriefSettingsSchema } from "../../../session/threadBriefStore.js";
import type { BriefProjectSuggestion, BriefThreadReference } from "../../../session/threadBriefTypes.js";
import type { DesktopThreadBriefRequest, DesktopThreadBriefSnapshot } from "../../threadBriefProtocol.js";
import type { DesktopProjectService } from "./DesktopProjectService.js";
import type { DesktopStateStore } from "./DesktopStateStore.js";

const id = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_-]+$/u);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("overview") }).strict(),
  z.object({ action: z.literal("configure"), config: threadBriefSettingsSchema }).strict(),
  z.object({ action: z.literal("history") }).strict(),
  z.object({ action: z.literal("backfill"), sessionId: id }).strict(),
  z.object({ action: z.literal("status"), sessionId: id, status: z.enum(["inbox", "todo", "done"]) }).strict(),
  z.object({ action: z.literal("dismiss"), id }).strict(),
  z.object({ action: z.literal("revise"), id, name: z.string().trim().min(1).max(120), brief: z.string().trim().min(1).max(2000), focus: z.string().trim().max(500), sessionIds: z.array(id).min(1).max(50) }).strict(),
  z.object({ action: z.literal("rewrite"), id, feedback: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ action: z.literal("choose-location"), id }).strict(),
  z.object({ action: z.literal("accept"), id }).strict()
]);

export class DesktopThreadBriefService {
  readonly engine: ThreadBriefService;
  private readonly accepting = new Set<string>();

  constructor(private readonly options: {
    configStore: AgentConfigStore;
    state: DesktopStateStore;
    projects: DesktopProjectService;
    store?: ThreadBriefStore;
    onChange?(): void;
    chooseProjectDirectory(suggestion: BriefProjectSuggestion): Promise<string | undefined>;
  }) {
    this.engine = new ThreadBriefService({
      store: options.store ?? new ThreadBriefStore(),
      readThread: (sessionId, minimumCreatedAt) => this.readThread(sessionId, minimumCreatedAt),
      getModel: async () => resolveToolModel(await options.configStore.load()),
      onChange: options.onChange
    });
  }

  async initialize(): Promise<void> { await this.engine.initialize(); }
  async close(): Promise<void> { await this.engine.close(); }

  async request(input: DesktopThreadBriefRequest): Promise<DesktopThreadBriefSnapshot> {
    const request = requestSchema.parse(input);
    const store = this.engine.store;
    let history: BriefThreadReference[] | undefined;
    switch (request.action) {
      case "overview": break;
      case "configure": this.engine.setConfig(request.config); break;
      case "history": {
        history = [];
        for (const project of this.options.state.projects()) {
          if (project.missing) continue;
          const entries = await listSessionCatalog(await this.options.projects.dataRoot(project));
          history.push(...entries.map((entry) => ({ sessionId: entry.id, projectId: project.id, title: entry.title ?? entry.summary.firstUserMessage.slice(0, 120), createdAt: entry.summary.createdAt })));
        }
        history.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        history = history.slice(0, 500);
        break;
      }
      case "backfill": {
        if (!await this.readThread(request.sessionId)) throw new Error("找不到对话。");
        await this.engine.enqueue(request.sessionId, true);
        break;
      }
      case "status": store.setStatus(request.sessionId, request.status); break;
      case "dismiss": {
        const suggestion = this.requireOpen(request.id);
        store.putSuggestion({ ...suggestion, status: "dismissed" });
        break;
      }
      case "revise": {
        const suggestion = this.requireOpen(request.id);
        const selected = new Set(request.sessionIds);
        if (request.sessionIds.some((sessionId) => !suggestion.threads.some((thread) => thread.sessionId === sessionId))) throw new Error("不能关联建议之外的对话。");
        store.putSuggestion({ ...suggestion, name: request.name, brief: request.brief, focus: request.focus, threads: suggestion.threads.filter((thread) => selected.has(thread.sessionId)) });
        break;
      }
      case "rewrite": {
        this.requireOpen(request.id);
        await this.engine.rewriteSuggestion(request.id, request.feedback);
        break;
      }
      case "choose-location": {
        const suggestion = this.requireOpen(request.id);
        if (suggestion.kind !== "create") throw new Error("已有项目的位置不能修改。");
        const location = await this.options.chooseProjectDirectory(suggestion);
        if (location) store.putSuggestion({ ...this.requireOpen(request.id), location });
        break;
      }
      case "accept": {
        const suggestion = this.requireOpen(request.id);
        this.accepting.add(request.id);
        try {
          let projectId = suggestion.projectId;
          if (suggestion.kind === "create" && !projectId) {
            const directory = suggestion.location ?? await this.options.chooseProjectDirectory(suggestion);
            if (!directory) break;
            // 只有原生对话框确认后才创建实际工作区；取消不创建目录或关联。
            const project = await this.options.projects.createEmptyProject(directory);
            projectId = project.id;
            // 先记住已创建的目标；若后续关联失败，重试不会重复创建目录。
            store.putSuggestion({ ...suggestion, projectId });
          }
          if (!projectId) throw new Error("缺少目标项目。");
          this.options.projects.requireProject(projectId);
          store.accept(request.id, projectId);
        } finally { this.accepting.delete(request.id); }
        break;
      }
    }
    if (request.action !== "overview" && request.action !== "history") this.options.onChange?.();
    const snapshot = store.snapshot();
    return { ...snapshot, history, suggestions: snapshot.suggestions.map((suggestion) => ({
      ...suggestion,
      location: suggestion.location ?? this.options.state.projects().find((project) => project.id === suggestion.projectId)?.path
    })) };
  }

  private requireOpen(id: string): BriefProjectSuggestion {
    if (this.accepting.has(id)) throw new Error("正在确认这个项目建议，请稍候。");
    const suggestion = this.engine.store.suggestion(id);
    if (!suggestion || suggestion.status !== "open") throw new Error("项目建议已处理或不存在。");
    return suggestion;
  }

  private async readThread(sessionId: string, minimumCreatedAt?: string): Promise<BriefThread | undefined> {
    for (const project of this.options.state.projects()) {
      if (project.missing) continue;
      const root = await this.options.projects.dataRoot(project);
      const file = await resolveSessionFile(root, sessionId).catch(() => undefined);
      if (!file || sessionIdFromFile(file) !== sessionId) continue;
      const catalog = await readSessionCatalogRecord(root, sessionId);
      // 自动路径先看控制面时间，旧对话不能为了判断是否要摘要而先读一遍正文。
      const createdAt = catalog?.createdAt ?? (await stat(file)).birthtime.toISOString();
      if (minimumCreatedAt && createdAt < minimumCreatedAt) return undefined;
      const [events, summary] = await Promise.all([readSessionEvents(file), readSessionSummary(root, sessionId)]);
      if (!summary) return undefined;
      const active = activeSessionMessageIds(events);
      const messages = sessionMessageTree(events).filter((node) => active.has(node.id)).flatMap((node) => {
        const role = node.message.role;
        if (role !== "user" && role !== "assistant") return [];
        const content = typeof node.message.content === "string" ? node.message.content : node.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        return [{ role, text: role === "user" ? publicUserMessage(content) : content }];
      });
      const title = catalog?.title ?? summary.firstUserMessage.slice(0, 120);
      return { sessionId, projectId: project.id, title, createdAt: summary.createdAt, messages,
        excluded: /^(?:⏰ Cron:|💓 Heartbeat)/u.test(title) };
    }
    return undefined;
  }
}
