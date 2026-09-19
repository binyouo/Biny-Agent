/** Biny 的公共 AI 类型；Agent Loop 与运行时服务保持为内部实现。 */
export * from "./activity/index.js";
export * from "./agent/context/crystalService.js";
export * from "./agent/context/crystalStorage.js";
export * from "./agent/context/crystalTypes.js";
export * from "./agent/context/fileMemory.js";
export * from "./agent/context/heartbeat.js";
export * from "./agent/context/selfReflection.js";
import type {
  MemoryClearResult as StoredMemoryClearResult,
  MemoryEntriesResult as StoredMemoryEntriesResult,
  MemoryEntry as StoredMemoryEntry,
  MemoryEntryInput as StoredMemoryEntryInput,
  MemoryMatch as StoredMemoryMatch,
  MemoryOverview as StoredMemoryOverview,
  MemoryRecallReport as StoredMemoryRecallReport,
  MemorySearchResult as StoredMemorySearchResult,
  MemoryWriteResult as StoredMemoryWriteResult
} from "./agent/context/memoryTypes.js";

export * from "./ai/index.js";
export type { AgentTurnOutcome, AgentTurnStatus, AgentTurnStopReason } from "./agent/types.js";
export type {
  AgentPersonalizationState,
  ChatPersonalizationOverride,
  ChatPersonalizationOverridePatch,
  GlobalPersonalizationUpdate,
  MemoryPolicy,
  PersonalizationMetadata,
  ResolvedChatPersonalization
} from "./personalization/index.js";
export type {
  MemoryDeleteResult,
  MemoryEntryPatch,
} from "./agent/context/memoryTypes.js";

export type MemoryEntryInput = StoredMemoryEntryInput;
export type MemoryEntry = StoredMemoryEntry;
export type MemoryOverview = StoredMemoryOverview;
export type MemoryEntriesResult = StoredMemoryEntriesResult;
export type MemoryClearResult = StoredMemoryClearResult;
export type MemoryRecallReport = StoredMemoryRecallReport;
export type MemoryMatch = StoredMemoryMatch;
export type MemorySearchResult = StoredMemorySearchResult;
export type MemoryWriteResult = StoredMemoryWriteResult;
