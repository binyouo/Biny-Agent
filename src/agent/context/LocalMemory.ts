/**
 * 本地记忆的模型编排层。
 *
 * MemoryStorage 负责单一 SQLite 事实库；本类负责会话调用上下文中的记忆抽取与自动写入。
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentMessage, AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { globalConfigDir } from "../../config/paths.js";
import { generateNativeText } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  maxMemoryContentChars,
  normalizeMemoryOriginAnchors,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import { MemoryStorage, StaleMemoryDecisionError } from "./memoryStorage.js";
import { memoryExtractionPrompt, memoryReconciliationPrompt, memoryTimeAnchorInstruction, temporaryMemoryCleanupPrompt, parseMemoryOperations, type MemoryOperation, type ExtractedMemory } from "./memoryExtraction.js";
import {
  type MemoryDerivedIndexSink,
  type MemoryClearResult,
  type MemoryArchiveEntriesResult,
  type MemoryArchiveChain,
  type MemoryArchiveReason,
  type MemoryArchiveResult,
  type MemoryBulkArchiveResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryOriginAnchor,
  type MemoryListOptions,
  type MemoryMatch,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemorySimilarEntrySearch,
  type MemoryWriteResult
} from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;

const memoryReconciliationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ADD") }).strict(),
  z.object({ operation: z.literal("NONE"), id: z.string().min(1).max(128) }).strict(),
  z.object({
    operation: z.literal("UPDATE"),
    id: z.string().min(1).max(128),
    content: z.string().trim().min(1).max(maxMemoryContentChars),
    durability: z.enum(["temporary", "permanent"])
  }).strict()
]);

/** 会话调用上下文中的事实操作与模型抽取；不持有全局维护状态。 */
export class LocalMemory {
  private readonly storage: MemoryStorage;
  private readonly recallLimitSource: number | (() => number);

  constructor(
    private readonly workspaceRoot: string,
    private readonly getToolModel: () => AgentModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    /** 共享记忆库合计自动注入条数上限。 */
    recallLimit: number | (() => number) = 3,
    private readonly onModelRequest: ModelRequestObserver = () => undefined,
    private readonly getModelRequestContext: () => ModelRequestContext | undefined = () => undefined,
    private readonly derivedIndex?: Pick<MemoryDerivedIndexSink, "indexEntry" | "removeEntries">,
    private readonly findSimilarEntries?: MemorySimilarEntrySearch,
    storageOptions: { agentDir?: string } = {}
  ) {
    this.recallLimitSource = recallLimit;
    this.storage = new MemoryStorage(workspaceRoot, storageOptions);
  }

  /**
   * 召回上限可以绑定到宿主配置。配置在每个根回合开始时刷新，因此这里不能只保存构造时快照。
   */
  get recallLimit(): number {
    return typeof this.recallLimitSource === "function"
      ? this.recallLimitSource()
      : this.recallLimitSource;
  }

  close(): void {
    this.storage.close();
  }

  // SQLite 事实、检索与生命周期操作。

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    return await this.storage.getOverview(options);
  }
  async listMemoryEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    return await this.storage.listEntries(options);
  }

  async getEntry(id: string, options: MemoryReadOptions = {}): Promise<MemoryEntry | undefined> {
    return await this.storage.getEntry(id, options);
  }

  async resolveArchiveChains(archiveIds: readonly string[], options: MemoryReadOptions = {}): Promise<Record<string, MemoryArchiveChain>> {
    return await this.storage.resolveArchiveChains(archiveIds, options);
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    const result = await this.storage.writeEntry(input, options);
    if (result.written && result.entry) await this.syncDerivedEntry(result.entry);
    return result;
  }

  /**
   * 自动贡献记忆的写入入口，根据语义候选决定新增、更新或保持不变。
   * 底层 writeEntry 不做精确去重；手动 /memory add 不经过这层模型判断。
   */
  async writeAutoEntry(
    input: MemoryEntryInput,
    options: MemoryMutationOptions & { requireSemantic?: boolean; checkpoint?: () => Promise<void> } = {}
  ): Promise<MemoryWriteResult & { updated?: boolean }> {
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    const safe = sanitizeMemoryEntryInput(input);
    const person = parsePersonMemory(safe.content);
    if (person) {
      await this.appendPersonMemory(person.name, person.fact, options.signal, options.checkpoint);
      return { written: false, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }

    const candidates = await this.findSemanticMemoryEntries(safe.content, 5, 0.3, options.signal, safe.userId ?? null);
    await options.checkpoint?.();
    if (options.requireSemantic && candidates === undefined) {
      return { written: false, deferred: true, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
    const decision = candidates?.length
      ? await this.reconcileMemory(safe, candidates, options.signal)
      : { operation: "ADD" as const };
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    if (!decision) {
      return { written: false, deferred: true, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
    try {
      if (decision.operation === "ADD") {
        return await this.writeEntry(safe, { ...options, expectedEntries: [...(options.expectedEntries ?? []), ...(candidates ?? [])] });
      }
      const target = candidates!.find((entry) => entry.id === decision.id)!;
      if (decision.operation === "NONE") {
        const current = await this.getEntry(target.id, { activeOnly: true, signal: options.signal });
        if (!current || current.revision !== target.revision) throw new StaleMemoryDecisionError();
        return { written: false, entry: current, path: `memory://${current.id}`, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
      }
      const result = await this.storage.updateEntry(target.id, {
        content: redactSecrets(decision.content),
        durability: decision.durability,
        source: safe.source,
        tags: [...new Set([...target.tags, ...(safe.tags ?? [])])],
        threadId: safe.threadId,
        messageId: safe.messageId,
        originAnchors: normalizeMemoryOriginAnchors([...(target.originAnchors ?? []), ...(safe.originAnchors ?? [])].slice(-32))
      }, {
        ...options,
        activeOnly: true,
        archivePrevious: true,
        expectedEntries: [...(options.expectedEntries ?? []), target]
      });
      if (result.written && result.entry) await this.syncDerivedEntry(result.entry);
      return { ...result, updated: result.written };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof StaleMemoryDecisionError)) throw error;
      return { written: false, deferred: true, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    const result = await this.storage.updateEntry(id, patch, options);
    if (result.written && result.entry) {
      if (result.entry.archivedAt === undefined) {
        await this.syncDerivedEntry(result.entry);
      }
    }
    return result;
  }

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions = {}): Promise<MemoryArchiveResult> {
    const result = await this.storage.archiveEntry(id, archived, options);
    // 重复恢复也允许重建派生向量，修复上一次写事实成功而索引失败的情况。
    if (archived) await this.removeDerivedEntries([id]);
    else if (result.entry) await this.syncDerivedEntry(result.entry);
    return result;
  }

  async archiveEntries(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMutationOptions & { mergedInto?: string } = {}
  ): Promise<MemoryBulkArchiveResult> {
    const result = await this.storage.archiveEntries(ids, reason, options);
    if (result.archived) await this.removeDerivedEntries(result.entries.map((entry) => entry.originalId ?? entry.id));
    return result;
  }

  async listArchivedEntries(options: MemoryListOptions = {}): Promise<MemoryArchiveEntriesResult> {
    return await this.storage.listArchivedEntries(options);
  }

  async deleteEntryById(id: string, options: MemoryMutationOptions = {}): Promise<MemoryDeleteResult> {
    const result = await this.storage.deleteEntry(id, options);
    // Archived versions have their own row ids; their originalId may still be an active fact.
    if (result.deleted && result.entry?.archivedAt === undefined) await this.removeDerivedEntries([id]);
    return result;
  }

  async clearAllEntries(options: MemoryMutationOptions = {}): Promise<MemoryClearResult> {
    const { deletedIds, ...result } = await this.storage.clearAll(options);
    if (deletedIds.length) await this.removeDerivedEntries(deletedIds);
    return result;
  }

  async clearThreadEntries(threadId: string, options: MemoryMutationOptions = {}): Promise<MemoryClearResult> {
    const { deletedIds, ...result } = await this.storage.clearThread(threadId, options);
    if (deletedIds.length) await this.removeDerivedEntries(deletedIds);
    return result;
  }

  /** SQLite 是权威源；派生索引失败只能降级召回，不能让成功写入变成失败。 */
  private async syncDerivedEntry(entry: MemoryEntry): Promise<void> {
    try {
      await this.derivedIndex?.indexEntry(entry);
    } catch {
      // 派生索引可由后续 rebuild 修复，不能回滚已经提交的 SQLite 事实。
    }
  }

  private async removeDerivedEntries(entryIds: readonly string[]): Promise<void> {
    try {
      await this.derivedIndex?.removeEntries?.(entryIds);
    } catch {
      // 派生索引可重建，不能阻断删除或归档。
    }
  }

  /** 记录「条目被实际引用」的使用投影，供 Sleep 选择 survivor。 */
  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.storage.recordRecallUsage(ids, options);
  }

  /**
   * 在成功回合结束后直接整理并写入记忆。这里不落候选表：模型一次返回 add/delete，
   * 每个变更都通过同一套 SQLite 事务写路径提交，失败也不会影响已经完成的对话。
   */
  async summarizeAndStoreMemories(
    messages: readonly AgentMessage[],
    options: {
      sessionId: string;
      turnId: string;
      messageId?: string;
      userId?: string;
      originAnchors?: MemoryOriginAnchor[];
      runId: string;
      externalContext: boolean;
      excludeExternalContext: boolean;
      signal?: AbortSignal;
      now?: Date;
      onMemoryWritten?: (entry: MemoryEntry) => Promise<void>;
    }
  ): Promise<{ created: ExtractedMemory[]; updated: ExtractedMemory[]; deleted: ExtractedMemory[] }> {
    options.signal?.throwIfAborted();
    if (options.excludeExternalContext && options.externalContext) return { created: [], updated: [], deleted: [] };
    const recentMessages = messages.slice(-4).filter((message) => message.role === "user" || message.role === "assistant");
    // Only summarize a completed turn when the tail contains at least two
    // messages. A single user/tool fragment is too easy to mistake for a
    // durable fact (and is not a completed conversational turn).
    if (recentMessages.length < 2) return { created: [], updated: [], deleted: [] };
    const originAnchors = normalizeMemoryOriginAnchors(options.originAnchors);
    let operations: MemoryOperation[];
    try {
      const response = await generateNativeText(this.getToolModel(), [{
        role: "user",
        content: "Extract memories from this conversation:\n\n" + formatMemoryExtractionMessages(recentMessages)
          + (originAnchors?.length ? "\n\nOriginal user message source anchors:\n" + originAnchors.map((anchor) =>
            `- messageId: ${anchor.messageId}; sentAt: ${anchor.sentAt}; timeZone: ${anchor.timeZone}`
          ).join("\n") : "")
      }], {
        systemPrompt: memoryExtractionPrompt + "\n\n" + memoryTimeAnchorInstruction,
        signal: options.signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      operations = parseMemoryOperations(response.text);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { created: [], updated: [], deleted: [] };
    }

    const now = options.now ?? new Date();
    const deleted: ExtractedMemory[] = [];
    const created: ExtractedMemory[] = [];
    const updated: ExtractedMemory[] = [];
    const retainedIds = new Set<string>();
    let additionFailed = false;
    for (const proposal of operations.filter((operation) => operation.operation === "add")) {
      options.signal?.throwIfAborted();
      try {
        const content = proposal.content.trim();
        if (!content) {
          additionFailed = true;
          continue;
        }
        const input = sanitizeMemoryEntryInput({
          content,
          source: "auto",
          threadId: options.sessionId,
          messageId: options.messageId,
          userId: options.userId,
          tags: ["conversation-summary"],
          durability: proposal.durability,
          originAnchors
        });
        // Generate an embedding before every automatic ADD. If the
        // semantic path is unavailable, skip this candidate instead of
        // treating unavailable reconciliation as permission to add a fact.
        const result = await this.writeAutoEntry(input, { signal: options.signal, now, requireSemantic: true });
        if (result.deferred) additionFailed = true;
        if (result.entry) retainedIds.add(result.entry.id);
        if (result.written) {
          (result.updated ? updated : created).push({ id: result.entry!.id, content: result.entry!.content });
          await options.onMemoryWritten?.(result.entry!);
        }
      } catch {
        options.signal?.throwIfAborted();
        additionFailed = true;
        // 模型返回的单条坏记忆只跳过这一条，不阻止其它条目提交。
      }
    }
    // 即使提取模型把更正拆成 delete + add，也不能在替代失败时先删旧事实。
    // 本轮新增、更新或确认保留的 ID 不再交给同一批删除和临时清理。
    if (!additionFailed) {
      for (const { content: description } of operations.filter((operation) => operation.operation === "delete")) {
        options.signal?.throwIfAborted();
        try {
          deleted.push(...await this.deleteMemoryByDescription(description, options.signal, now, options.userId ?? null, retainedIds));
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      deleted.push(...await this.cleanupTemporaryMemories(
        formatMemoryExtractionMessages(recentMessages), now, options.signal, options.userId ?? null, retainedIds, originAnchors
      ));
    }
    return { created, updated, deleted };
  }

  private async findSemanticMemoryEntries(
    query: string,
    limit: number,
    minimumSimilarity: number,
    signal?: AbortSignal,
    userId?: string | null
  ): Promise<MemoryEntry[] | undefined> {
    if (!this.findSimilarEntries) return undefined;
    let candidates: MemoryEntry[] | undefined;
    try {
      candidates = await this.findSimilarEntries(query, { limit, minimumSimilarity, signal, userId });
    } catch {
      signal?.throwIfAborted();
      // 不可用交给调用方处理，不能冒充“没有相关事实”。
      return undefined;
    }
    const scoped = userId === undefined ? candidates : candidates?.filter((entry) => entry.userId === (userId ?? undefined));
    // 写入判断、语义删除和 temporary 清理共用搜索；scope 过滤后的命中立即计入访问记录，
    // 后续模型即使没有选中某条事实也不撤销统计。
    if (scoped?.length) await this.recordRecallUsage(scoped.map((entry) => entry.id), { signal });
    return scoped;
  }

  private async reconcileMemory(
    proposed: MemoryEntryInput,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<z.infer<typeof memoryReconciliationSchema> | undefined> {
    const prompt = "Reconcile proposed memory:\n" + JSON.stringify({
      proposed: { content: proposed.content, durability: proposed.durability, originAnchors: proposed.originAnchors },
      candidates: candidates.map((entry) => ({
        id: entry.id, content: entry.content, durability: entry.durability, originAnchors: entry.originAnchors
      }))
    });
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        systemPrompt: memoryReconciliationPrompt + "\n\n" + memoryTimeAnchorInstruction,
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const object = response.text.match(/\{[\s\S]*\}/u);
      if (!object) return undefined;
      const parsed = memoryReconciliationSchema.safeParse(JSON.parse(object[0]));
      if (!parsed.success) return undefined;
      const decision = parsed.data;
      if (decision.operation !== "ADD" && !candidates.some((entry) => entry.id === decision.id)) return undefined;
      return decision;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async deleteMemoryByDescription(description: string, signal: AbortSignal | undefined, now: Date, userId: string | null, retainedIds: ReadonlySet<string>): Promise<ExtractedMemory[]> {
    if (!description.trim()) return [];
    const candidates = (await this.findSemanticMemoryEntries(description.trim(), 10, 0, signal, userId))?.filter((entry) => !retainedIds.has(entry.id));
    if (!candidates?.length) return [];
    const selectedIndexes = await this.selectMemoryDeletionCandidates(description, candidates, signal);
    const deleted: ExtractedMemory[] = [];
    for (const index of selectedIndexes) {
      signal?.throwIfAborted();
      const entry = candidates[index - 1];
      if (!entry) continue;
      try {
        const result = await this.deleteEntryById(entry.id, { signal, now, expectedEntries: [entry] });
        if (result.deleted) deleted.push({ id: entry.id, content: entry.content });
      } catch {
        signal?.throwIfAborted();
        // 一个语义删除失败不应阻止同一轮继续清理其它候选。
      }
    }
    return deleted;
  }

  private async selectMemoryDeletionCandidates(
    description: string,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<number[]> {
    const prompt = `The user wants to delete memories about: "${description}"\n\nHere are the candidate memories from the database:\n${candidates.map((entry, index) => `${index + 1}. ${entry.durability === "temporary" ? "[temporary]" : "[permanent]"} ${entry.content}`).join("\n")}\n\nWhich memories should be deleted? Respond with ONLY a JSON array of the numbers (1-indexed) of memories that should be deleted.\nIf none should be deleted, respond with [].\nExample response: [1, 3, 5] or []\n\nBe precise - only select memories that truly match what the user wants to delete.`;
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const array = response.text.match(/\[[\d,\s]*\]/u);
      if (!array) return [];
      const parsed: unknown = JSON.parse(array[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((index): index is number => typeof index === "number" && index >= 1 && index <= candidates.length);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  private async cleanupTemporaryMemories(
    conversation: string, now: Date, signal: AbortSignal | undefined, userId: string | null,
    retainedIds: ReadonlySet<string>, originAnchors?: MemoryOriginAnchor[]
  ): Promise<ExtractedMemory[]> {
    let candidates: MemoryEntry[] | undefined;
    try {
      candidates = await this.findSemanticMemoryEntries(conversation, 20, 0.3, signal, userId);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      // 清理候选读取或访问统计失败不能丢掉此前已提交的自动 add/delete 结果。
      return [];
    }
    const temporary = candidates?.filter((entry) => entry.durability === "temporary" && !retainedIds.has(entry.id)) ?? [];
    if (!temporary.length) return [];
    const formatDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString()}`;
    const memories = temporary.map((entry) => {
      const source = entry.originAnchors?.length
        ? `source-message anchors: ${JSON.stringify(entry.originAnchors)}`
        : "original message time/timezone unknown";
      return `- id: "${entry.id}", created: "${formatDate(new Date(entry.createdAt))}", content: "${entry.content}" [Memory saved-at: ${entry.createdAt}; ${source}; saved-at is NOT event/due/completion time.]`;
    }).join("\n");
    const conversationSource = originAnchors?.length
      ? `source-message anchors: ${JSON.stringify(originAnchors)}`
      : "original message time/timezone unknown";
    const prompt = `Current date and time: ${formatDate(now)}\n\nCurrent conversation context:\n${conversation}\n\nCurrent conversation source: ${conversationSource}\n\nTemporary memories related to this conversation:\n${memories}`;
    let selected: unknown[];
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        systemPrompt: temporaryMemoryCleanupPrompt + "\n\n" + memoryTimeAnchorInstruction,
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const array = response.text.match(/\[[\s\S]*?\]/u);
      if (!array) return [];
      const parsed: unknown = JSON.parse(array[0]);
      if (!Array.isArray(parsed)) return [];
      selected = parsed;
    } catch {
      signal?.throwIfAborted();
      return [];
    }
    const deleted: ExtractedMemory[] = [];
    for (const id of selected) {
      const entry = temporary.find((candidate) => candidate.id === id);
      if (!entry) continue;
      signal?.throwIfAborted();
      try {
        const result = await this.deleteEntryById(entry.id, { signal, now, expectedEntries: [entry] });
        if (result.deleted) deleted.push({ id: entry.id, content: entry.content });
      } catch {
        signal?.throwIfAborted();
      }
    }
    return deleted;
  }

  private async appendPersonMemory(name: string, fact: string, signal?: AbortSignal,
    checkpoint?: () => Promise<void>): Promise<void> {
    signal?.throwIfAborted();
    const safeName = sanitizePersonFileName(name);
    if (!safeName) return;
    const peopleRoot = path.join(globalConfigDir(), "people");
    await mkdir(peopleRoot, { recursive: true, mode: 0o700 });
    await checkpoint?.();
    await appendFile(
      path.join(peopleRoot, `${safeName}.md`),
      `- ${redactSecrets(fact).replace(/\s+/gu, " ").trim()}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

}

interface PersonMemory {
  name: string;
  fact: string;
}

function parsePersonMemory(summary: string): PersonMemory | undefined {
  const match = /^PERSON:\s*([^:\n]{1,120}):\s*(.{1,2000})$/su.exec(summary.trim());
  if (!match?.[1] || !match[2]?.trim()) return undefined;
  return { name: match[1].trim(), fact: match[2].trim() };
}

function sanitizePersonFileName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 80)
    .replace(/[._-]+$/gu, "");
}

export function formatMemoryMatches(matches: Array<Pick<MemoryMatch, "entry" | "excerpt">>): string {
  if (!matches.length) return "";
  // 来源消息时间与记忆保存时间必须分开呈现，避免模型把保存时间误当事件时间。
  return [
    "## Relevant Memories",
    memoryTimeAnchorInstruction,
    "Only a subset of relevant memories is shown. Search with biny memory search for missing facts.",
    ...matches.map((match) => {
      const tags = match.entry.tags.filter((tag) => tag && tag !== "conversation-summary");
      const source = match.entry.originAnchors?.length
        ? `source-message anchors: ${JSON.stringify(match.entry.originAnchors)}`
        : "original message time/timezone unknown";
      const temporal = match.entry.durability === "temporary" ? "[temporary; may be outdated] " : "";
      return `- ${temporal}${match.excerpt}${tags.length ? ` [tags: ${tags.join(", ")}]` : ""} [Memory saved-at: ${match.entry.createdAt}; ${source}; saved-at is NOT event/due/completion time.]`;
    })
  ].join("\n");
}

function formatMemoryExtractionMessages(messages: readonly AgentMessage[]): string {
  return messages.map((message) => {
    const content = message.role === "user" ? message.originalContent ?? message.content : message.content;
    const text = typeof content === "string" ? content : content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return `${message.role}: ${redactSecrets(text)}`;
  }).join("\n\n");
}

export { redactSecrets };
export type {
  MemoryBudgetOmission,
  MemoryArchiveReason,
  MemoryClearResult,
  MemoryBulkArchiveResult,
  MemoryDeleteResult,
  MemoryEntriesResult,
  MemoryEntry,
  MemoryEntryInput,
  MemoryDurability,
  MemoryListOptions,
  MemoryMaintenanceOptions,
  MemoryMaintenanceResult,
  MemoryMaintenanceStatus,
  MemoryMatch,
  MemoryMutationOptions,
  MemoryOmissionReason,
  MemoryOverview,
  MemoryReadOptions,
  MemoryRecallReport,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySimilarityPair,
  MemoryWriteResult
} from "./memoryTypes.js";
