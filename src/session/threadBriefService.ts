/** 后台摘要单消费者队列；模型只提供候选判断，引用、预算和所有持久化边界由本地裁决。 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentModel } from "../agent/core/types.js";
import { generateNativeText, nativeJsonMessages } from "../llm/nativeJson.js";
import { redactSecrets } from "../utils/secrets.js";
import { ThreadBriefStore } from "./threadBriefStore.js";
import { briefClusterPrompt, briefLinkPrompt, briefRevisionPrompt, threadBriefPrompt } from "./threadBriefPrompts.js";
import type { BriefProjectSuggestion, BriefThreadReference, ThreadBriefRecord, ThreadBriefSettings } from "./threadBriefTypes.js";

export interface BriefThread extends BriefThreadReference {
  excluded?: boolean;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

const shortText = z.string().trim().max(400);
const briefSchema = z.object({
  topic: shortText.min(1), goal: shortText,
  objects: z.array(shortText.min(1)).max(8), conclusions: z.array(shortText.min(1)).max(8),
  followUp: z.object({ what: z.string().trim().min(1).max(200), quote: z.string().trim().min(1).max(300) }).nullable()
});
const clusterSchema = z.object({ sameThing: z.boolean(), members: z.array(z.number().int().positive()).max(50), name: z.string().trim().max(120), brief: z.string().trim().max(2000), focus: z.string().trim().max(500), reason: shortText });
const linkSchema = z.object({ belongs: z.boolean(), reason: shortText });
const genericObjects = new Set(["code", "app", "ui", "api", "bug", "test", "file", "project", "项目", "代码", "问题", "功能", "文件"]);
const tokens = (objects: string[]): Set<string> => new Set(objects.map((text) => text.normalize("NFKC").toLowerCase().replace(/[\s_/\\.,:;!?'"()[\]{}<>·、，。！？：；「」『』（）]+/gu, "")).filter((text) => text.length >= 2 && !genericObjects.has(text)));

interface BriefJob { sessionId: string; manual: boolean; resolve(): void; reject(error: unknown): void }

export class ThreadBriefService {
  readonly store: ThreadBriefStore;
  private readonly queue: BriefJob[] = [];
  private draining?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private readonly now: () => Date;

  constructor(private readonly options: {
    store: ThreadBriefStore;
    readThread(sessionId: string, minimumCreatedAt?: string): Promise<BriefThread | undefined>;
    getModel(): Promise<AgentModel | undefined>;
    canPersist?(threads: readonly BriefThreadReference[]): Promise<boolean>;
    now?: () => Date;
    onChange?(): void;
  }) { this.store = options.store; this.now = options.now ?? (() => new Date()); }

  async initialize(): Promise<void> { await this.store.open(); }
  setConfig(config: ThreadBriefSettings): void {
    this.store.setConfig(config);
    // 关闭或修改预算立即取消旧策略下的请求，迟到结果不得再写入。
    this.controller?.abort(new Error("摘要设置已更改，请按新设置重试。"));
    this.options.onChange?.();
  }

  enqueue(sessionId: string, manual = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error("摘要服务已关闭。"));
    // 自动事件可合并；手工请求各自保留完成结果。运行中的会话可排一次后续刷新。
    if (!manual && this.queue.some((job) => job.sessionId === sessionId)) return Promise.resolve();
    if (this.queue.length >= 64) return Promise.reject(new Error("摘要队列已满，请稍后重试。"));
    const result = new Promise<void>((resolve, reject) => this.queue.push({ sessionId, manual, resolve, reject }));
    this.startDrain();
    return result;
  }

  private startDrain(): void {
    if (this.draining || this.closed) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // 完成通知的微任务可在 finally 前追加下一份作业，不能让它留在空闲队列里。
      if (this.queue.length) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const job = this.queue.shift()!;
      this.controller = new AbortController();
      try { await this.generate(job.sessionId, job.manual, this.controller.signal); job.resolve(); }
      catch (error) {
        if (!this.controller.signal.aborted) {
          this.store.setError({ sessionId: job.sessionId, message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500), at: this.now().toISOString() });
          this.options.onChange?.();
        }
        job.reject(error);
      }
      finally { this.controller = undefined; }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort(new Error("摘要服务已关闭。"));
    for (const job of this.queue.splice(0)) job.reject(new Error("摘要服务已关闭。"));
    await this.draining;
    this.store.close();
  }

  async rewriteSuggestion(id: string, feedback: string): Promise<void> {
    const original = this.store.suggestion(id);
    if (!original || original.status !== "open") throw new Error("项目建议已处理或不存在。");
    if (!await this.mayPersist(original.threads)) throw new Error("项目建议的来源对话已不可用。");
    const model = await this.options.getModel();
    if (!model) throw new Error("请先配置工具模型。");
    const revision = z.object({ name: z.string().trim().min(1).max(120), brief: z.string().trim().min(1).max(2000), focus: z.string().trim().max(500), drop: z.array(z.string()).max(50), reason: shortText }).parse(
      await this.ask(model, briefRevisionPrompt, { suggestion: original, feedback }, new AbortController().signal)
    );
    // 模型返回期间可能已经确认/忽略，迟到改写不能重新打开建议或覆盖用户编辑。
    const latest = this.store.suggestion(id);
    if (!latest || JSON.stringify(latest) !== JSON.stringify(original)) throw new Error("项目建议已发生变化，请重新查看。");
    if (revision.drop.some((id) => !original.threads.some((thread) => thread.sessionId === id))) throw new Error("改写包含建议之外的对话。");
    const threads = original.threads.filter((thread) => !revision.drop.includes(thread.sessionId));
    if (!threads.length) throw new Error("项目建议至少需要保留一段对话。");
    if (!await this.mayPersist(threads)) throw new Error("项目建议的来源对话已不可用。");
    this.store.putSuggestion({ ...original, name: revision.name, brief: revision.brief, focus: revision.focus, reason: revision.reason, threads });
    this.options.onChange?.();
  }

  private async ask(model: AgentModel, system: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const result = await generateNativeText(model, nativeJsonMessages(system, redactSecrets(JSON.stringify(input))), {
      signal, timeoutMs: 30_000, maxOutputTokens: 1600, maxRetries: 0
    });
    signal.throwIfAborted();
    try { return JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/gu, "")); }
    catch { throw new Error("摘要模型返回了无效 JSON。"); }
  }

  private async generate(sessionId: string, manual: boolean, signal: AbortSignal): Promise<void> {
    const config = this.store.config();
    if (!config.enabled && !manual) return;
    const thread = await this.options.readThread(sessionId, manual ? undefined : this.store.enabledAt());
    signal.throwIfAborted();
    if (!thread || thread.excluded || (!manual && thread.createdAt < this.store.enabledAt())) return;
    const messages = thread.messages.map((message) => ({ role: message.role, text: redactSecrets(message.text)
      .replace(/```[\s\S]*?```/gu, " [code] ")
      .replace(/<(system-reminder|appshot|picked-element)\b[^>]*>[\s\S]*?<\/\1>/gu, " ")
      .replace(/[ \t]+/gu, " ").trim().slice(0, message.role === "user" ? 1200 : 400) })).filter((message) => message.text);
    const userTurns = messages.filter((message) => message.role === "user").length;
    if (!messages.length || (!manual && userTurns < config.minUserTurns)) return;
    const fullMaterial = messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n");
    const material = fullMaterial.length > 12_000 ? `[earlier turns omitted]\n${fullMaterial.slice(-12_000)}` : fullMaterial;
    const hash = createHash("sha256").update(material).digest("hex");
    const previous = this.store.brief(sessionId);
    if (previous?.contentHash === hash) return;
    if (previous && !manual && fullMaterial.length - previous.materialLength < config.minNewChars) return;
    const model = await this.options.getModel();
    if (!model) { if (manual) throw new Error("请先在通用设置中配置可用的工具模型。"); return; }
    const parsed = briefSchema.safeParse(await this.ask(model, threadBriefPrompt, { previous: previous?.brief, conversation: material }, signal));
    if (!parsed.success) throw new Error("摘要模型返回的字段无效。");
    const brief = parsed.data;
    // 引用必须来自确实发给模型的用户文本；仅凭模型声称“用户说过”不能增加待办。
    if (brief.followUp && !messages.some((message) => message.role === "user" && message.text.includes(brief.followUp!.quote) && material.includes(`USER: ${message.text}`))) brief.followUp = null;
    signal.throwIfAborted();
    if (!await this.mayPersist([thread])) return;
    signal.throwIfAborted();
    this.store.putBrief({
      sessionId, projectId: thread.projectId, title: thread.title, createdAt: thread.createdAt,
      brief, contentHash: hash, materialLength: fullMaterial.length, userTurns, updatedAt: this.now().toISOString(),
      status: "inbox", statusManual: false
    });
    this.store.setError(undefined);
    this.options.onChange?.();
    if (config.enabled && config.projectSuggestions) await this.suggest(this.store.brief(sessionId)!, model, config, signal);
  }

  private async suggest(current: ThreadBriefRecord, model: AgentModel, config: ThreadBriefSettings, signal: AbortSignal): Promise<void> {
    if (!await this.mayPersist([reference(current)])) return;
    const currentTokens = tokens(current.brief.objects);
    if (!currentTokens.size) return;
    const projects = (await Promise.all(this.store.projects().map(async (project) =>
      await this.mayPersist(project.threads) ? project : undefined))).filter((project) => project !== undefined);
    if (projects.some((project) => project.threads.some((thread) => thread.sessionId === current.sessionId))) return;
    for (const project of projects) {
      const projectTokens = tokens([project.name, ...project.brief.split(/[\s,、，。;；]+/u)]);
      if (![...currentTokens].some((token) => projectTokens.has(token))) continue;
      const signature = `link:${project.projectId}:${current.sessionId}`;
      if (this.store.hasSignature(signature)) continue;
      const result = linkSchema.parse(await this.ask(model, briefLinkPrompt, { project, conversation: current.brief }, signal));
      if (!await this.mayPersist([reference(current), ...project.threads])) return;
      signal.throwIfAborted();
      this.store.putSuggestion({ id: randomUUID(), signature, kind: "link", projectId: project.projectId,
        status: result.belongs ? "open" : "rejected", name: project.name, brief: project.brief, focus: project.focus,
        reason: result.reason, threads: [reference(current)], createdAt: this.now().toISOString() });
      this.options.onChange?.();
      if (result.belongs) return;
    }
    const assigned = new Set(projects.flatMap((project) => project.threads.map((thread) => thread.sessionId)));
    const candidates = (await Promise.all(this.store.briefs().filter((entry) => entry.sessionId !== current.sessionId && !assigned.has(entry.sessionId))
      .map(async (entry) => await this.mayPersist([reference(entry)]) ? entry : undefined))).filter((entry) => entry !== undefined);
    let cluster: ThreadBriefRecord[] = [];
    for (const token of currentTokens) {
      const matching = [current, ...candidates.filter((entry) => tokens(entry.brief.objects).has(token))].slice(0, 50);
      if (matching.length >= config.cluster.threads && distinctDays(matching) >= config.cluster.spread && matching.length > cluster.length) cluster = matching;
    }
    if (!cluster.length) return;
    const signature = `create:${cluster.map((entry) => entry.sessionId).sort().join(",")}`;
    if (this.store.hasSignature(signature)) return;
    const result = clusterSchema.parse(await this.ask(model, briefClusterPrompt, cluster.map((entry, index) => ({ number: index + 1, title: entry.title, date: entry.createdAt, ...entry.brief })), signal));
    const members = [...new Set(result.members)].flatMap((number) => cluster[number - 1] ? [cluster[number - 1]!] : []);
    const valid = result.sameThing && Boolean(result.name && result.brief) && members.length >= config.cluster.threads && distinctDays(members) >= config.cluster.spread;
    const selectedSignature = `create:${members.map((entry) => entry.sessionId).sort().join(",")}`;
    const suggestion: BriefProjectSuggestion = {
      id: randomUUID(), signature, kind: "create", status: "rejected", name: result.name, brief: result.brief,
      focus: result.focus, reason: result.reason, threads: cluster.map(reference), createdAt: this.now().toISOString()
    };
    if (!await this.mayPersist(cluster.map(reference))) return;
    signal.throwIfAborted();
    // 同时记住整个候选组的判定，避免删掉成员后又反复询问同一组材料。
    if (!valid || signature !== selectedSignature) this.store.putSuggestion(suggestion);
    if (valid && !this.store.hasSignature(selectedSignature)) this.store.putSuggestion({ ...suggestion, id: randomUUID(), signature: selectedSignature, status: "open", threads: members.map(reference) });
    this.options.onChange?.();
  }

  private async mayPersist(threads: readonly BriefThreadReference[]): Promise<boolean> {
    return this.options.canPersist === undefined || await this.options.canPersist(threads);
  }
}

function reference(record: ThreadBriefRecord): BriefThreadReference { return { sessionId: record.sessionId, projectId: record.projectId, title: record.title, createdAt: record.createdAt }; }
function distinctDays(records: ThreadBriefRecord[]): number { return new Set(records.map((record) => record.createdAt.slice(0, 10))).size; }
