import { z } from "zod";
import type { EmbeddingModelRef } from "../llm/embedding/types.js";

export const embeddingModelRefSchema: z.ZodType<EmbeddingModelRef> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }).strict(),
  z.object({
    kind: z.literal("local"),
    model: z.literal("multilingual-e5-small")
  }).strict(),
  z.object({
    kind: z.literal("provider"),
    provider: z.string().min(1),
    model: z.string().min(1)
  }).strict()
]);

export type { EmbeddingModelRef } from "../llm/embedding/types.js";

const rawMemoryPolicySchema = z.object({
  // enabled 是硬门禁；聊天级 use/contribute 覆盖不能绕过它。
  enabled: z.boolean().optional(),
  useMemories: z.boolean().default(true),
  generateMemories: z.boolean().default(true),
  // 语义召回：概览注入之外的 embedding 检索；查询重写可用便宜模型改写检索词。
  queryRewrite: z.boolean().default(true),
  memoryModel: z.string().min(1).optional(),
  rewriteModel: z.string().min(1).optional(),
  extractModel: z.string().min(1).optional(),
  // 嵌入模型默认本地 multilingual-e5-small（可下载）；云端需 provider 已配置并经隐私确认。
  embeddingModel: embeddingModelRefSchema.optional(),
  similarityThreshold: z.number().min(0).max(1).default(0.1),
  // 外部网页、MCP/Plugin 与子代理结果默认不进入自动记忆候选。
  excludeExternalContext: z.boolean().default(true),
  // 自动注入条数上限（概览之外的条目召回）。
  maxRecalled: z.number().int().min(1).max(20).default(5),
  sleepEnabled: z.boolean().default(true),
  sleepTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).default("03:00"),
  archiveRetentionDays: z.number().int().min(1).max(3650).default(30),
  temporaryTtl: z.number().int().min(1).max(3650).default(30),
  similarityMergeThreshold: z.number().min(0).max(1).default(0.95),
  useLlm: z.boolean().default(true),
  llmMergeLow: z.number().min(0).max(1).default(0.75),
  llmBatchSize: z.number().int().min(1).max(100).default(20),
}).strict();

type MemoryPolicyOutput = Omit<z.infer<typeof rawMemoryPolicySchema>, "enabled"> & { enabled: boolean };

export const memoryPolicySchema = rawMemoryPolicySchema.transform((policy): MemoryPolicyOutput => ({
  ...policy,
  // 缺少总开关的旧配置按两个自动开关的 OR 推导；显式关闭总开关时由迁移结果保留关闭语义。
  enabled: policy.enabled ?? (policy.useMemories || policy.generateMemories),
  // 历史配置可能已经有 context.memory，但没有 embeddingModel；默认仍必须是本地 E5。
  embeddingModel: policy.embeddingModel ?? { kind: "auto" }
})).default({
  enabled: true,
  useMemories: true,
  generateMemories: true,
  queryRewrite: true,
  memoryModel: undefined,
  rewriteModel: undefined,
  extractModel: undefined,
  embeddingModel: { kind: "auto" },
  similarityThreshold: 0.1,
  excludeExternalContext: true,
  maxRecalled: 5,
  sleepEnabled: true,
  sleepTime: "03:00",
  archiveRetentionDays: 30,
  temporaryTtl: 30,
  similarityMergeThreshold: 0.95,
  useLlm: true,
  llmMergeLow: 0.75,
  llmBatchSize: 20
});

export type MemoryPolicy = MemoryPolicyOutput;

/**
 * 按聊天的记忆开关覆盖。人格/指令字段已从可编辑面移除，但旧 session catalog 记录里仍可能
 * 携带这些废弃键；`.passthrough()` + transform 读旧记录时丢弃它们，只保留记忆开关。
 */
const chatMemorySwitchSchema = z.union([z.literal("inherit"), z.boolean()]);

export const chatPersonalizationOverrideSchema = z.object({
  useMemories: chatMemorySwitchSchema,
  contributeMemories: chatMemorySwitchSchema
}).passthrough().transform(({ useMemories, contributeMemories }) => ({ useMemories, contributeMemories }));

export type ChatPersonalizationOverride = z.infer<typeof chatPersonalizationOverrideSchema>;

export const chatPersonalizationOverridePatchSchema = z.object({
  useMemories: chatMemorySwitchSchema.optional(),
  contributeMemories: chatMemorySwitchSchema.optional()
}).strict();

export const defaultChatPersonalizationOverride: ChatPersonalizationOverride = {
  useMemories: "inherit",
  contributeMemories: "inherit"
};

export type ChatPersonalizationOverridePatch = z.infer<typeof chatPersonalizationOverridePatchSchema>;

/**
 * 持久化到 session/telemetry 的个性化元数据占位。人格/指令已下线，此结构仅保留为历史
 * session 记录的兼容字段（SessionContextState.personalization），不再承载任何信息。
 */
export type PersonalizationMetadata = object;

export interface ResolvedChatPersonalization {
  memoryEnabled: boolean;
  useMemories: boolean;
  contributeMemories: boolean;
  queryRewrite: boolean;
  memoryModel?: string;
  rewriteModel?: string;
  extractModel?: string;
  embeddingModel?: EmbeddingModelRef;
  similarityThreshold: number;
  excludeExternalContext: boolean;
  maxRecalled: number;
  sleepEnabled: boolean;
  sleepTime: string;
  archiveRetentionDays: number;
}

export interface AgentPersonalizationState {
  /** 当前工作区的有效记忆策略（全局 config 叠加 project settings 后）。 */
  memory: MemoryPolicy;
  override: ChatPersonalizationOverride;
  resolved: ResolvedChatPersonalization;
  catalogRevision: string;
  configRevision?: string;
}

export const globalPersonalizationUpdateSchema = z.object({
  memory: memoryPolicySchema.optional()
}).strict();

export type GlobalPersonalizationUpdate = z.infer<typeof globalPersonalizationUpdateSchema>;

export function resolveChatPersonalization(
  memory: MemoryPolicy,
  override: ChatPersonalizationOverride = defaultChatPersonalizationOverride
): ResolvedChatPersonalization {
  const parsedMemory = memoryPolicySchema.parse(memory);
  const parsedOverride = chatPersonalizationOverrideSchema.parse(override);
  return {
    memoryEnabled: parsedMemory.enabled,
    useMemories: parsedMemory.enabled && (parsedOverride.useMemories === "inherit" ? parsedMemory.useMemories : parsedOverride.useMemories),
    contributeMemories: parsedMemory.enabled && (parsedOverride.contributeMemories === "inherit"
      ? parsedMemory.generateMemories
      : parsedOverride.contributeMemories),
    memoryModel: parsedMemory.memoryModel,
    queryRewrite: parsedMemory.queryRewrite,
    rewriteModel: parsedMemory.rewriteModel,
    extractModel: parsedMemory.extractModel,
    embeddingModel: parsedMemory.embeddingModel,
    similarityThreshold: parsedMemory.similarityThreshold,
    excludeExternalContext: parsedMemory.excludeExternalContext,
    maxRecalled: parsedMemory.maxRecalled,
    sleepEnabled: parsedMemory.sleepEnabled,
    sleepTime: parsedMemory.sleepTime,
    archiveRetentionDays: parsedMemory.archiveRetentionDays
  };
}

export function mergeChatPersonalizationOverride(
  current: ChatPersonalizationOverride,
  patch: ChatPersonalizationOverridePatch
): ChatPersonalizationOverride {
  const parsedPatch = chatPersonalizationOverridePatchSchema.parse(patch);
  return chatPersonalizationOverrideSchema.parse({
    ...current,
    useMemories: parsedPatch.useMemories === undefined ? current.useMemories : parsedPatch.useMemories,
    contributeMemories: parsedPatch.contributeMemories === undefined
      ? current.contributeMemories
      : parsedPatch.contributeMemories
  });
}

export function personalizationMetadata(): PersonalizationMetadata {
  return {};
}

export function metadataForPersonalization(): PersonalizationMetadata {
  return {};
}

export function cloneChatPersonalizationOverride(
  override: ChatPersonalizationOverride
): ChatPersonalizationOverride {
  return { ...override };
}
