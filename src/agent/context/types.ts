/**
 * 上下文层共享类型。
 *
 * 工作区上下文、仓库地图、压缩状态、token 预算和本地记忆之间互相引用，类型集中放在这里，
 * 避免各实现文件之间循环依赖。
 */
import type { ProjectContext } from "../../project/ProjectContext.js";
import type { SessionContextUsage } from "../../session/metadata.js";

export interface LoadedInstruction {
  path: string;
  content: string;
  bytes: number;
}

export interface ProjectSnapshot {
  context: ProjectContext;
  refreshedAt: string;
  revision: number;
}

export type RepoMapRole = "entry" | "test" | "source" | "config" | "other";

export interface RepoMapEntry {
  path: string;
  role: RepoMapRole;
  symbols: string[];
  imports: string[];
  exports: string[];
}

export interface RecentWorkspaceActivity {
  paths: string[];
  summaries: string[];
}

/** 单轮对话要注入模型的工作区材料。 */
export interface WorkspaceTurnData {
  instructions: LoadedInstruction[];
  snapshot: ProjectSnapshot;
  explicitPaths: string[];
  recentActivity: RecentWorkspaceActivity;
  repoMapCandidates: RepoMapEntry[];
}

/**
 * token 预算现状。`source` 区分是本地估算还是 provider 回报的真实用量，
 * `omitted` 列出因预算不足被丢掉的上下文块，便于界面解释「为什么没带上这些内容」。
 */
export type ContextBudgetStatus = SessionContextUsage;

export interface CompactionStatus {
  summaryPresent: boolean;
  compactedMessages: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  compactedMessageCount: number;
  retainedMessageCount: number;
  tokensBefore: number;
  summary?: string;
}

/** 仅用于实时准备进度，不作为持久化上下文事实。 */
export type PreparationStage = "memory" | "skills" | "tools" | "workspace" | "compacting" | "waiting" | "ready";

export interface ContextStatus {
  /** 当前轮次已完成的能力预选结果。 */
  capabilitySelection?: import("../capabilitySelection.js").AgentCapabilitySelection;
  loadedInstructions: string[];
  instructionBytes: number;
  instructionCapBytes: number;
  snapshotRefreshedAt?: string;
  snapshotDirty: boolean;
  repoMapRefreshedAt?: string;
  repoMapDirty: boolean;
  repoMapEntries: number;
  activePaths: string[];
  recentActivity: RecentWorkspaceActivity;
  compaction: CompactionStatus;
  budget: ContextBudgetStatus;
  memoryEnabled: boolean;
  /** 本轮经过上下文预算筛选后实际注入的记忆条数。 */
  memoryInjectedCount?: number;
  /** 本轮实际注入模型上下文的记忆摘要；用于本地界面解释召回结果。 */
  memoryInjectedSummaries: string[];
  /** 本轮自动记忆召回降级原因（向量索引缺失/模型不匹配等）；存在时界面应主动提示。 */
  memoryRecallDegraded?: string;
  memoryOverviewChars?: number;
}

export interface MemoryMatch {
  path: string;
  excerpt: string;
  tags?: string[];
  score: number;
}
