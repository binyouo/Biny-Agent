/**
 * 本地记忆的稳定公共契约。
 *
 * 记忆是扁平的事实文本：content 就是事实正文，其余全部是可展示的元数据。所有条目
 * 保存在一个全局记忆库中，不做 user/workspace 来源分桶；所有写操作共享一个单调
 * revision 仅用于标记内容变更；SQLite 写事务保证原子提交，不要求调用方预读版本。
 */

/** Sleep 用 durability 区分会自然过期的短期记忆和长期记忆。 */
export type MemoryDurability = "temporary" | "permanent";

/** archive reason 使用稳定名称；旧短名称只用于读取当前开发库中的历史行。 */
export type MemoryArchiveReason = "exact_dup" | "exact" | "expired" | "orphan" | "similarity_merge" | "llm_merge" | "similarity" | "llm" | "manual";

/** 稳定 id、时间与 revision 由存储层生成。 */
export interface MemoryEntryInput {
  /** 记忆正文；就是这条事实本身，也是 embedding 的唯一输入。 */
  content: string;
  /** 来源标签；自动写入为 "auto"，手动写入为 "manual"，管线可扩展。 */
  source?: string;
  tags?: string[];
  /** 模型或用户给出的保存理由。 */
  rationale?: string;
  /** 显式数值原样保留；底层默认 0.5。 */
  importance?: number;
  durability?: MemoryDurability;
  expiresAt?: string;
  /** 可选的对话来源关联。 */
  threadId?: string;
  messageId?: string;
  userId?: string;
  activitySource?: string;
  activitySessionId?: string;
  accessCount?: number;
  archivedAt?: string;
  archivedReason?: MemoryArchiveReason;
  mergedInto?: string;
}

export interface MemoryEntryPatch {
  content?: string;
  source?: string;
  tags?: string[];
  rationale?: string;
  importance?: number;
  durability?: MemoryDurability;
  expiresAt?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
  mergedInto?: string;
}

export interface MemoryEntry {
  id: string;
  /** 归档条目拥有独立的 archive row id，并用 originalId 关联原活动条目。 */
  originalId?: string;
  content: string;
  source: string;
  tags: string[];
  rationale?: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** 该条目最近写入时单一记忆库的 revision。 */
  revision: number;
  durability: MemoryDurability;
  expiresAt?: string;
  /** SQLite 行上的 usage 字段；不会改变事实 revision。 */
  accessCount: number;
  lastAccessedAt?: string;
  /** memory_archive 对应的可恢复归档状态。 */
  archivedAt?: string;
  archivedReason?: MemoryArchiveReason;
  /** 归档时指向保留下来的 survivor 或新 synthesis。 */
  mergedInto?: string;
  /** 产生该归档记录的操作（Sleep run id 或 manual）。 */
  archivedBy?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
  activitySource?: string;
  activitySessionId?: string;
}

/** 自动贡献记忆时使用的语义候选查询；undefined 表示 embedding/index 当前不可用。 */
export interface MemorySimilarSearchOptions extends MemoryReadOptions {
  limit: number;
  minimumSimilarity: number;
}

export type MemorySimilarEntrySearch = (
  query: string,
  options: MemorySimilarSearchOptions
) => Promise<MemoryEntry[] | undefined>;

export interface MemoryOverview {
  storeRevision: number;
  entryCount: number;
}

export interface MemoryReadOptions {
  signal?: AbortSignal;
}

export interface MemoryMutationOptions extends MemoryReadOptions {
  /** 测试与确定性维护可注入时间；普通调用无需传入。 */
  now?: Date;
  /** 归档审计来源；Sleep 使用 run id，手动归档默认 manual。 */
  archivedBy?: string;
  /** Sleep 的共享执行权；手工事实操作不受 Sleep 执行权约束。 */
  sleepOwnerToken?: string;
  /** 跨异步步骤的 Sleep 决定必须仍基于这些活动条目的原版本。 */
  expectedEntries?: readonly MemoryEntry[];
}

export interface MemoryListOptions extends MemoryReadOptions {
  limit?: number;
  /** 分页起始偏移；与 limit 组合实现 offset 分页。 */
  offset?: number;
  /** 默认隐藏归档记忆；管理界面可显式读取。 */
  includeArchived?: boolean;
}

export interface MemoryEntriesResult {
  entries: MemoryEntry[];
  /** 条目 ID 到稳定 memory:// 引用的映射，供向量独占命中仍能回到事实条目。 */
  paths?: Record<string, string>;
  storeRevision: number;
  /** 分页前的条目总数；供分页 UI 计算页数。 */
  total: number;
}

export interface MemoryWriteResult {
  written: boolean;
  /** 必需的语义检索暂不可用，不等同于已写入或已确认重复。 */
  deferred?: boolean;
  entry?: MemoryEntry;
  path?: string;
  revision: number;
}

export interface MemoryDeleteResult {
  deleted: boolean;
  entry?: MemoryEntry;
  revision: number;
}

export interface MemoryArchiveEntriesResult {
  entries: MemoryEntry[];
  storeRevision: number;
  total: number;
}

export interface MemoryArchiveResult {
  archived: boolean;
  entry?: MemoryEntry;
  revision: number;
}

export interface MemoryBulkArchiveResult {
  entries: MemoryEntry[];
  archived: number;
  revision: number;
}

export interface MemoryClearResult {
  deletedEntries: number;
  revision: number;
}

export interface MemoryMatch {
  entry: MemoryEntry;
  path: string;
  excerpt: string;
  score: number;
}

export type MemoryOmissionReason = "entry_limit" | "budget" | "invalid";

export interface MemoryBudgetOmission {
  maxChars: number;
  usedChars: number;
  omitted: number;
}

export interface MemoryRecallReport {
  omitted: Array<{ id: string; reason: MemoryOmissionReason }>;
  budgetOmission?: MemoryBudgetOmission;
  /**
   * 自动召回为空且原因不是"库里没有相关内容"时给出降级原因，供界面主动提示；
   * 手动词法回退路径不携带该字段。
   */
  degraded?: "no_vector_index" | "no_embedding_runtime" | "model_mismatch";
}

export interface MemorySearchOptions extends MemoryReadOptions {
  includeArchived?: boolean;
  /** tag 后过滤：条目必须同时携带这里列出的全部标签；空/缺省表示不过滤。 */
  tags?: string[];
  /** 单库合计上限。 */
  limit?: number;
  /** 注入预算；命中条目超过预算时在 report 中明确标为 budget。 */
  maxChars?: number;
  now?: Date;
}

export interface MemorySearchResult {
  matches: MemoryMatch[];
  storeRevision: number;
  report: MemoryRecallReport;
}

/**
 * SQLite 事实写入后的派生索引同步边界。
 *
 * indexEntry 只处理仍然存在的单条新增；requestRebuild 只发出批量失效信号，调用方应在
 * 当前维护批次结束后再调度重建，避免与后续 memory mutation 并发。
 */
export interface MemoryDerivedIndexSink {
  prepareSynthesis?(content: string, signal?: AbortSignal): Promise<((entry: MemoryEntry) => void) | undefined>;
  indexEntry(entry: MemoryEntry): Promise<void>;
  removeEntries?(entryIds: readonly string[]): void;
  requestRebuild?(): void;
  findSimilarPairs?: (
    entries: readonly MemoryEntry[],
    minimumSimilarity: number,
    signal?: AbortSignal
  ) => Promise<MemorySimilarityScan>;
}

export interface MemorySimilarityScan {
  examined: number;
  pairs: MemorySimilarityPair[];
}

export interface MemorySimilarityPair {
  leftId: string;
  rightId: string;
  similarity: number;
}

export interface MemoryMaintenanceOptions extends MemoryReadOptions {
  sleepEnabled?: boolean;
  now?: Date;
  trigger?: "scheduled" | "manual" | "idle" | "count";
  archiveRetentionDays?: number;
  temporaryTtl?: number;
  similarityMergeThreshold?: number;
  useLlm?: boolean;
  llmMergeLow?: number;
  llmBatchSize?: number;
}

export interface MemorySleepPreview {
  examined?: number;
  skipped?: string;
  archiveProposed?: Array<{ id: string; content: string; reason: MemoryArchiveReason; mergedInto?: string }>;
  synthesisProposed?: Array<{ content: string; durability: MemoryDurability; sourceIds: string[] }>;
  inputTokens?: number;
  outputTokens?: number;
  available: boolean;
  entries: number;
  temporaryToArchive: number;
  archivedToDelete: number;
  recentRuns: number;
  lastRun?: MemorySleepRun;
}

export interface MemorySleepRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  trigger: "scheduled" | "manual" | "idle" | "count";
  examined: number;
  written: number;
  failed: number;
  archived: number;
  exact: number;
  expired: number;
  similarity: number;
  llm: number;
  /** Sleep run 的详细审计字段；旧的短字段保留为 UI/历史读取别名。 */
  archivedExact: number;
  archivedExpired: number;
  archivedOrphan: number;
  archivedSimilarity: number;
  archivedLlm: number;
  /** 本轮 Sleep 中模型提出、但最终未能落库的合成条目数。 */
  synthesisFailed: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface MemoryMaintenanceResult {
  scanned: number;
  processed: number;
  written: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
}

export interface MemoryMaintenanceStatus {
  state: "idle" | "running";
  startedAt?: string;
  lastScanAt?: string;
  lastFinishedAt?: string;
  eligible: number;
  processed: number;
  written: number;
  failed: number;
  error?: string;
  lastRun?: MemorySleepRun;
  /** 最近的睡眠整理历史，最多保留 20 次。 */
  sleepRuns?: MemorySleepRun[];
}
