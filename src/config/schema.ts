/**
 * Runtime configuration schema.
 *
 * Providers own credentials and endpoints, while model aliases own model IDs and
 * capabilities. Only the canonical multi-model format is accepted.
 */
import { z } from "zod";
import { DEFAULT_PROJECT_SKILL_PATHS } from "../extensions/skillRoots.js";
import {
  activityDataResidencySchema,
  activitySettingsSchema,
  type ActivityDataResidency,
  type ActivitySettings,
  defaultActivitySettings
} from "../activity/settings.js";
import {
  memoryPolicySchema,
  type MemoryPolicy
} from "../personalization/index.js";
import { GLOBAL_CONFIG_FORMAT, GLOBAL_CONFIG_VERSION } from "./migrations.js";

const agentSchema = z.object({
  softStepLimit: z.number().int().min(1).max(1_024).default(32),
  hardStepLimit: z.number().int().min(1).max(1_024).default(96),
  maxToolCalls: z.number().int().min(1).max(65_536).optional(),
  maxRepeatedActions: z.number().int().min(1).max(32).default(3),
  maxConcurrentTools: z.number().int().min(1).max(32).default(4),
  maxQueuedToolCalls: z.number().int().min(1).max(1_024).default(64)
}).strict().default({
  softStepLimit: 32,
  hardStepLimit: 96,
  maxToolCalls: undefined,
  maxRepeatedActions: 3,
  maxConcurrentTools: 4,
  maxQueuedToolCalls: 64
});

const permissionSchema = z.object({
  mode: z.enum(["ask", "read-only", "auto", "full-access"]).default("full-access"),
  allowTools: z.array(z.string()).default(["Read", "Glob", "Grep", "WebSearch", "save_memory"]),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([".env", ".env.local", ".ssh/", "node_modules/"]),
  criticalAlwaysAsk: z.boolean().default(true)
}).default({
  mode: "full-access",
  allowTools: ["Read", "Glob", "Grep", "WebSearch", "save_memory"],
  allowPaths: [],
  denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
  criticalAlwaysAsk: true
});

const capabilityDefaultSelectionSchema = z.enum(["auto", "all", "none"]);

/**
 * 自动压缩策略。reserve/keep 缺省时按当前模型可用输入预算动态缩放；显式配置时作为额外上限。
 * 触发阈值优先级：显式 reserveTokens > triggerPercent > 模型参考线/动态推导。
 */
export const compactionSchema = z.object({
  enabled: z.boolean().default(true),
  reserveTokens: z.number().int().min(256).max(262_144).optional(),
  /** 触发阈值 = 当前输入预算 × 该百分比；与显式 reserveTokens 同时配置时以后者为准。 */
  triggerPercent: z.number().min(0.5).max(0.95).optional(),
  /** 与 keepRecentTokens 共同构成保留段双上限，取更保守（保留更少）的安全切分点。 */
  keepRecentTokens: z.number().int().min(256).max(1_000_000).optional(),
  keepRecentMessages: z.number().int().min(1).max(500).optional(),
  maxSummaryTokens: z.number().int().min(256).max(32_768).default(4_096),
  /** 压缩摘要专用模型别名；缺省跟随当前对话模型。 */
  summaryModel: z.string().trim().min(1).max(128).optional()
}).default({
  enabled: true,
  reserveTokens: undefined,
  triggerPercent: undefined,
  keepRecentTokens: undefined,
  keepRecentMessages: undefined,
  maxSummaryTokens: 4_096,
  summaryModel: undefined
});

/** 回合后自动技能提取（自进化）：analyst→author 两步辅助模型，写入受管全局技能根。 */
export const skillExtractionSchema = z.object({
  /** 总开关；关闭后成功回合不再触发旁路分析。 */
  enabled: z.boolean().default(true),
  /** 本回合工具调用数达到阈值才分析，避免普通问答也跑辅助模型。 */
  minToolCalls: z.number().int().min(1).max(100).default(5)
}).default({ enabled: true, minToolCalls: 5 });

export type SkillExtractionConfig = z.infer<typeof skillExtractionSchema>;

/**
 * 聊天采样参数（全局）。temperature 缺省不下发请求体（跟随模型/provider 默认）；
 * maxOutputTokens 缺省跟随模型别名配置，显式配置后全局覆盖。
 */
export const chatParamsSchema = z.object({
  /** 实验开关：覆盖协议自动选择，让 Read/Edit 使用行哈希。 */
  hashlineEdit: z.boolean().optional(),
  /** Prompt 缓存标记：按协议给 system 和请求尾部打断言点以命中服务商缓存；严格网关不认时可关闭。 */
  cacheMarkers: z.boolean().default(true),
  /** 采样温度 0–2；越低越确定，越高越发散。 */
  temperature: z.number().min(0).max(2).optional(),
  /** 单次回复的最大输出 token 数。 */
  maxOutputTokens: z.number().int().min(256).max(131_072).optional(),
  /** 默认把哪些工具暴露给模型；单条消息可在 Composer 中覆盖。 */
  defaultToolSelection: capabilityDefaultSelectionSchema.default("auto"),
  /** 默认把哪些 Skill 元数据暴露给模型；单条消息可在 Composer 中覆盖。 */
  defaultSkillSelection: capabilityDefaultSelectionSchema.default("auto"),
  skillExtraction: skillExtractionSchema
}).default({
  cacheMarkers: true,
  temperature: undefined,
  maxOutputTokens: undefined,
  defaultToolSelection: "auto",
  defaultSkillSelection: "auto",
  skillExtraction: { enabled: true, minToolCalls: 5 }
});

const identityPolicySchema = z.object({
  /** 用户资料区块的全局开关；核心 Soul 始终来自应用内置资源。 */
  enabled: z.boolean().default(true),
  /** USER.md 是否进入模型上下文；用户资料可以独立关闭。 */
  userEnabled: z.boolean().default(true)
}).strict().default({ enabled: true, userEnabled: true });

export type IdentityPolicy = z.infer<typeof identityPolicySchema>;

const crystalThresholdSchema = z.object({
  count: z.number().int().min(2).max(200),
  turns: z.number().int().min(2).max(200),
  spread: z.number().int().min(1).max(50)
}).strict();

export const crystalSettingsSchema = z.object({
  passiveEnabled: z.boolean().default(true),
  semanticScanEnabled: z.boolean().default(true),
  contour: crystalThresholdSchema.default({ count: 4, turns: 3, spread: 2 }),
  nucleus: crystalThresholdSchema.default({ count: 8, turns: 5, spread: 2 }),
  dormantDays: z.number().int().min(1).max(3_650).default(14)
}).strict().default({
  passiveEnabled: true,
  semanticScanEnabled: true,
  contour: { count: 4, turns: 3, spread: 2 },
  nucleus: { count: 8, turns: 5, spread: 2 },
  dormantDays: 14
});

export type CrystalSettings = z.infer<typeof crystalSettingsSchema>;

/**
 * 心跳(Heartbeat)后台巡检的开关与节奏。默认关闭,由用户显式开启;默认节奏与
 * Alma 对齐(30 分钟间隔、8–23 点活动时段)。未知键直接剥离,旧配置里的遗留
 * heartbeat 对象可以安全落入新结构。
 */
export const heartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(1).max(1_440).default(30),
  activeHoursStart: z.number().int().min(0).max(23).default(8),
  activeHoursEnd: z.number().int().min(0).max(23).default(23)
}).default({
  enabled: false,
  intervalMinutes: 30,
  activeHoursStart: 8,
  activeHoursEnd: 23
});

const contextSchema = z.object({
  // 不配置时按当前模型的上下文窗口自动推导；配置了就作为额外上限。
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  // A turn retains this much cumulative tool output in model context. Later
  // results are archived under .biny/tool-results with a bounded preview.
  maxTurnToolResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024).default(128 * 1024),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).default(32 * 1024),
  compaction: compactionSchema,
  identity: identityPolicySchema,
  memory: memoryPolicySchema
}).default({
  maxTurnToolResultBytes: 128 * 1024,
  instructionsMaxBytes: 32 * 1024,
  compaction: { enabled: true, reserveTokens: undefined, triggerPercent: undefined, keepRecentTokens: undefined, keepRecentMessages: undefined, maxSummaryTokens: 4_096, summaryModel: undefined },
  identity: { enabled: true, userEnabled: true },
  memory: {
    enabled: true,
    useMemories: true,
    generateMemories: true,
    queryRewrite: true,
    memoryModel: undefined,
    rewriteModel: undefined,
    extractModel: undefined,
    embeddingModel: { kind: "local", model: "multilingual-e5-small" },
    similarityThreshold: 0.1,
    cloudEmbeddingConsents: {},
    excludeExternalContext: true,
    maxRecalled: 5
  }
});

const extensionIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Provider 与 API ID 是扩展点，内置值只提供默认实现，不限制插件注册的新类型。 */
export const modelProviderSchema = extensionIdSchema;

export const providerProtocolSchema = z.enum(["anthropic", "openai-compatible"]);
export const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelApiBackendSchema = extensionIdSchema;

export const modelCompatibilitySchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
});

export const thinkingLevelMapSchema = z.record(z.string(), z.string().min(1).nullable()).superRefine((map, context) => {
  for (const key of Object.keys(map)) {
    if (!thinkingLevelSchema.options.includes(key as z.infer<typeof thinkingLevelSchema>)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Unknown thinking level: ${key}.`
      });
    }
  }
});

/**
 * 连接下按原始模型 ID 保存的用户元数据覆盖。
 *
 * 这组字段与 alias 的传输配置分开，目录刷新只能更新运行时投影，不能覆盖用户在这里
 * 明确填写的上下文窗口、输入/输出上限或 thinking 参数映射。
 */
const modelCapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoningStream: z.boolean().optional(),
  reasoningSummary: z.boolean().optional(),
  vision: z.boolean().optional(),
  audio: z.boolean().optional(),
  streaming: z.boolean().optional()
});

export const modelProfileSchema = z.object({
  /** 只保存用户主动修改的能力；未填写时跟随当前目录。 */
  capabilities: modelCapabilitiesSchema.optional(),
  /** 仅控制模型选择器可见性，停用时保留配置和已有会话引用。 */
  showInPicker: z.boolean().optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(384_000).optional(),
  thinkingLevelMap: thinkingLevelMapSchema.optional()
}).strict();

const thinkingSchema = z.object({
  enabled: z.boolean().default(true),
  // 默认 medium：high 档思考链明显更长，日常对话收益有限；模型不支持 medium 时会投影到最近档位。
  effort: reasoningEffortSchema.default("medium")
}).default({ enabled: true, effort: "medium" });

export const providerEmbeddingModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256),
  dimensions: z.number().int().min(1).max(65_536).optional(),
  /** 语义召回的最低相似度；未配置时使用运行时推荐值。 */
  recommendedThreshold: z.number().min(0).max(1).optional()
}).strict();

const providerConfigSchema = z.object({
  type: modelProviderSchema,
  /** 用户自定义服务商的显示名；内置目录服务商不使用，列表标签优先于端点主机名。 */
  displayName: z.string().trim().min(1).max(80).optional(),
  protocol: providerProtocolSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  requiresApiKey: z.boolean().optional(),
  /** 模型目录的鉴权要求独立于聊天请求；未设置时沿用 requiresApiKey。 */
  modelsRequiresApiKey: z.boolean().optional(),
  authMode: z.enum(["api-key", "oauth-bearer"]).optional(),
  oauth: z.object({
    provider: extensionIdSchema,
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.number().int().positive(),
    accountId: z.string().min(1).optional()
  }).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(6).default(3),
    initialDelayMs: z.number().int().min(0).max(30_000).default(250),
    maxDelayMs: z.number().int().min(0).max(120_000).default(4_000)
  }).optional(),
  modelsEndpoint: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  apiBackend: modelApiBackendSchema.optional(),
  compatibility: modelCompatibilitySchema.optional(),
  /** 自定义 Responses 端点须明确声明，不根据模型名称推断协议支持。 */
  applyPatchProtocol: z.enum(["openai-structured", "off"]).optional(),
  modelProfiles: z.record(z.string().trim().min(1).max(240), modelProfileSchema).optional(),
  /** 外部端点不得凭 URL 推断本地性；未来本地服务必须显式声明。 */
  dataResidency: activityDataResidencySchema.optional(),
  /** 仅显式声明的 provider embedding 型号会进入目录；不会从聊天模型或 ID 猜测。 */
  embeddingModels: z.array(providerEmbeddingModelSchema).max(64).optional()
}).superRefine((provider, context) => {
  const embeddingIds = new Set<string>();
  for (const [index, model] of (provider.embeddingModels ?? []).entries()) {
    if (embeddingIds.has(model.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddingModels", index, "id"],
        message: `Duplicate embedding model id: ${model.id}`
      });
    }
    embeddingIds.add(model.id);
  }
  if (provider.type === "openai-compatible" && !provider.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "openai-compatible requires a provider baseUrl."
    });
  }
  if (provider.authMode === "oauth-bearer" && !provider.oauth) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["oauth"],
      message: "oauth-bearer requires OAuth refresh metadata."
    });
  }
  if (provider.oauth?.provider === "claude-code" && provider.type !== "claude-subscription") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Claude OAuth credentials require the claude-subscription provider."
    });
  }
  if (provider.oauth?.provider === "openai-codex" && provider.type !== "openai-codex") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Codex OAuth credentials require the openai-codex provider."
    });
  }
});

const modelPricingSchema = z.object({
  inputPerMillionTokens: z.number().nonnegative().optional(),
  outputPerMillionTokens: z.number().nonnegative().optional(),
  cacheReadPerMillionTokens: z.number().nonnegative().optional(),
  cacheWritePerMillionTokens: z.number().nonnegative().optional()
});

const mcpServerSchema = z.object({
  /** 按服务端原始工具名显式启用固定契约，不依据远端 annotations 自动启用。 */
  toolContracts: z.record(z.literal("file-change-v1")).optional(),
  /** 用于凭据 account 稳定关联；旧配置没有该字段时在下一次桌面保存时补齐。 */
  id: z.string().uuid().optional(),
  description: z.string().trim().max(2_000).optional(),
  type: z.enum(["stdio", "http"]).optional(),
  /** Remote 新配置可显式选择协议；缺省时保留 streamable HTTP -> SSE 回退。 */
  transportProtocol: z.enum(["streamable-http", "sse"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  /** env/header 的值保存在 Keychain；这里仅保存 account 引用。 */
  credentialRefs: z.object({
    env: z.record(z.string().min(1).max(512)).optional(),
    headers: z.record(z.string().min(1).max(512)).optional()
  }).optional(),
  cwd: z.string().min(1).optional(),
  stderr: z.enum(["ignore", "inherit", "pipe"]).default("ignore"),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  oauth: z.object({
    clientId: z.string().trim().min(1).max(2_000).optional(),
    scopes: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
    redirectPort: z.number().int().min(1024).max(65535).optional()
  }).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  enabled: z.boolean().default(true)
}).superRefine((server, context) => {
  // type 省略时按字段推断：有 url 走 http，否则走 stdio。
  const transport = server.type ?? (server.url ? "http" : "stdio");
  if (server.oauth && transport !== "http") context.addIssue({ code: z.ZodIssueCode.custom, path: ["oauth"], message: "MCP OAuth 仅适用于 HTTP 服务。" });
  if (server.oauth && [...Object.keys(server.headers ?? {}), ...Object.keys(server.credentialRefs?.headers ?? {})].some((key) => key.toLowerCase() === "authorization")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "OAuth 与 Authorization 请求头不能同时配置。" });
  if (transport === "stdio" && !server.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio MCP server requires a command" });
  }
  if (transport === "http" && !server.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "http MCP server requires a url" });
  }
});

export const defaultSubagentAllowedTools = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash"
] as const;

const subagentToolNameSchema = z.enum(defaultSubagentAllowedTools);

const skillActivationMapSchema = z.record(z.boolean()).superRefine((value, context) => {
  if (Object.keys(value).length > 512) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill 开关数量不能超过 512。" });
  }
});

const skillProjectOverridesSchema = z.record(skillActivationMapSchema).superRefine((value, context) => {
  if (Object.keys(value).length > 64) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill 项目覆盖数量不能超过 64。" });
  }
});

const extensionsSchema = z.object({
  mcp: z.record(mcpServerSchema).default({}),
  skills: z.array(z.string().trim().min(1)).max(32).default([...DEFAULT_PROJECT_SKILL_PATHS]),
  skillDefaults: skillActivationMapSchema.default({}),
  skillProjectOverrides: skillProjectOverridesSchema.default({}),
  plugins: z.array(z.string().trim().min(1)).max(32).default([]),
  /** 全局配置目录下的 Plugin 路径；只允许在 ~/.config/biny/plugins 内解析。 */
  globalPlugins: z.array(z.string().trim().min(1)).max(32).default([]),
  subagent: z.object({
    enabled: z.boolean().default(false),
    maxSteps: z.number().int().min(1).max(32).default(16),
    maxOutputTokens: z.number().int().min(256).max(32_768).default(8_000),
    maxConcurrentSubagents: z.number().int().min(1).max(8).default(2),
    maxPendingSubagents: z.number().int().min(0).max(128).default(16),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
    model: z.string().min(1).optional(),
    maxCostUsd: z.number().positive().max(100).optional(),
    allowedTools: z.array(subagentToolNameSchema).min(1).default([...defaultSubagentAllowedTools]),
    // 具名子代理定义目录（workspace 相对路径）；全局 ~/.config/biny/agents 始终生效。
    agentPaths: z.array(z.string().trim().min(1)).max(32).default([".biny/agents"])
  }).default({
    enabled: false,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents"]
  })
}).default({
  mcp: {},
  skills: [".agents/skills", ".biny/skills"],
  skillDefaults: {},
  skillProjectOverrides: {},
  plugins: [],
  globalPlugins: [],
  subagent: {
    enabled: false,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents"]
  }
});

const webSearchSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["duckduckgo", "google", "tavily", "brave", "anysearch"]).default("anysearch"),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  maxResults: z.number().int().min(1).max(10).default(5)
}).default({
  enabled: false,
  provider: "anysearch",
  apiKey: undefined,
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
});

/**
 * 共享 cookie jar：桌面端内嵌浏览器登录后写入，`WebSearch` 的 Google provider 和
 * `WebFetch` 读取，用来访问需要登录态的页面。
 *
 * 打开它意味着模型选定的 URL 会带上真实登录凭据（只发给域名匹配的站点）。`WebFetch`
 * 默认不在免确认工具白名单里，每次抓取仍要用户确认，这是这项能力的主要约束。
 */
const webCookiesSchema = z.object({
  enabled: z.boolean().default(false),
  /** jar 文件位置；留空用桌面端 userData 下的共享路径，桌面端与 CLI 因此读到同一份。 */
  path: z.string().min(1).optional()
}).default({ enabled: false, path: undefined });

const webFetchSchema = z.object({
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  maxBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  // 只在用户明确要抓本机开发服务时开启：关掉的是私网/环回/云元数据地址的防线。
  allowPrivateNetwork: z.boolean().default(false)
}).default({
  enabled: false,
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  allowPrivateNetwork: false
});

const hookSchema = z.object({
  command: z.string().min(1),
  /** 只对这些工具触发；留空表示全部。 */
  tools: z.array(z.string().min(1)).max(32).default([]),
  /** 只对这些扩展名的目标路径触发；留空表示不按扩展名过滤。 */
  extensions: z.array(z.string().min(1).startsWith(".")).max(32).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000)
});

const hooksSchema = z.object({
  /** 工具执行前触发；非零退出会阻止这次调用。 */
  beforeTool: z.array(hookSchema).max(16).default([]),
  /** 工具执行后触发；输出附在结果上，退出码不影响调用结果。 */
  afterTool: z.array(hookSchema).max(16).default([])
}).default({ beforeTool: [], afterTool: [] });

const sandboxSchema = z.object({
  /**
   * `workspace-write`：命令仍以当前用户权限运行，但内核层面只允许写工作区、临时目录和常见
   * 缓存目录。这是独立于命令字符串判定的第二道边界。目前只有 macOS 有实现。
   */
  mode: z.enum(["off", "workspace-write"]).default("off"),
  allowNetwork: z.boolean().default(true)
}).default({ mode: "off", allowNetwork: true });

const checkpointsSchema = z.object({
  /** 每个回合首次改动工作区前自动建一个快照，供 /undo 回退。仅在 git 仓库内生效。 */
  enabled: z.boolean().default(true)
}).default({ enabled: true });

const diagnosticsSchema = z.object({
  enabled: z.boolean().default(false),
  /** 自动识别项目本地已安装的检查工具（目前是 TypeScript）；只用本地二进制，不联网安装。 */
  autoDetect: z.boolean().default(false),
  autoDetectTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  maxOutputBytes: z.number().int().min(256).max(1024 * 1024).default(8 * 1024),
  commands: z.array(z.object({
    extensions: z.array(z.string().min(1).startsWith(".")).min(1).max(16),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)
  })).max(8).default([])
}).default({
  enabled: false,
  autoDetect: false,
  autoDetectTimeoutMs: 120_000,
  maxOutputBytes: 8 * 1024,
  commands: []
});

const webSchema = z.object({
  search: webSearchSchema,
  fetch: webFetchSchema,
  cookies: webCookiesSchema
}).default({
  search: {
    enabled: false,
    provider: "anysearch",
    apiKey: undefined,
    apiKeyEnv: undefined,
    timeoutMs: 10_000,
    maxResults: 5
  },
  fetch: {
    enabled: false,
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
    allowPrivateNetwork: false
  },
  cookies: { enabled: false, path: undefined }
});

const modelThinkingSchema = z.object({
  efforts: z.array(reasoningEffortSchema).min(1).default(["high", "max"]),
  defaultEffort: reasoningEffortSchema.default("high"),
  mapping: z.record(reasoningEffortSchema, z.string().min(1)).optional(),
  budgetTokens: z.record(reasoningEffortSchema, z.number().int().min(256).max(131_072)).optional()
}).superRefine((thinking, context) => {
  if (!thinking.efforts.includes(thinking.defaultEffort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultEffort"],
      message: "defaultEffort must be included in efforts."
    });
  }
});

export const modelLimitsSchema = z.object({
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  reasoningReserveTokens: z.number().int().min(0).max(131_072).optional(),
  toolSchemaReserveTokens: z.number().int().min(0).max(131_072).optional(),
  systemPromptReserveTokens: z.number().int().min(0).max(131_072).optional(),
  protocolSafetyMarginTokens: z.number().int().min(0).max(131_072).optional()
}).strict();

const modelAliasSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 仅作为未来隐私白名单的显式声明，当前 v1 不会因此放行 Activity。 */
  dataResidency: activityDataResidencySchema.optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  supportsTools: z.boolean().optional(),
  capabilities: modelCapabilitiesSchema.optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(384_000).optional(),
  limits: modelLimitsSchema.optional(),
  /** Model-level API and compatibility override the provider defaults. */
  apiBackend: modelApiBackendSchema.optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: modelCompatibilitySchema.optional(),
  /** Canonical capability map. Missing/null levels are unsupported. */
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
  reasoning: modelThinkingSchema.optional(),
  pricing: modelPricingSchema.optional()
});

const canonicalConfigSchema = z.object({
  format: z.literal(GLOBAL_CONFIG_FORMAT),
  configVersion: z.literal(GLOBAL_CONFIG_VERSION),
  needsEmbeddingRebuild: z.boolean().default(false),
  defaultModel: z.string().min(1),
  /** 活动分析、摘要与建议共用的工具模型；省略时从可用配置自动选择。 */
  toolModel: z.string().trim().min(1).max(240).optional(),
  providers: z.record(providerConfigSchema),
  /** 凭据正文保存在 Keychain；这里仅保存并发 CAS 使用的非机密版本 nonce。 */
  credentialRevisions: z.record(z.string().min(1).max(128)).optional(),
  models: z.record(modelAliasSchema),
  thinking: thinkingSchema,
  agent: agentSchema,
  heartbeat: heartbeatConfigSchema,
  permission: permissionSchema,
  workspace: z.object({
    ignore: z.array(z.string())
  }),
  activity: activitySettingsSchema,
  crystal: crystalSettingsSchema,
  context: contextSchema,
  chat: chatParamsSchema,
  diagnostics: diagnosticsSchema,
  checkpoints: checkpointsSchema,
  sandbox: sandboxSchema,
  hooks: hooksSchema,
  web: webSchema,
  telemetry: z.object({
    enabled: z.boolean().default(false),
    recordInputs: z.boolean().default(false),
    recordOutputs: z.boolean().default(false)
  }).default({ enabled: false, recordInputs: false, recordOutputs: false }),
  extensions: extensionsSchema
}).strict().superRefine((config, context) => {
  const activeModel = config.models[config.defaultModel];
  if (!activeModel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultModel"],
      message: `Unknown default model alias: ${config.defaultModel}`
    });
  }

  for (const [alias, model] of Object.entries(config.models)) {
    const provider = config.providers[model.provider];
    if (!provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", alias, "provider"],
        message: `Unknown provider alias: ${model.provider}`
      });
      continue;
    }
    // Reasoning is opt-in per model. The native provider transport maps the
    // configured effort to the provider's request fields.
  }

  const activeReasoning = activeModel?.reasoning;
  const activeThinkingLevels = activeModel?.thinkingLevelMap;
  const activeSupportsReasoning = activeThinkingLevels
    ? Object.entries(activeThinkingLevels).some(([level, native]) => level !== "off" && native !== null)
    : activeReasoning !== undefined;
  // ProviderRuntime 还会根据 provider 默认值补齐动态目录/未知模型的能力；配置层不能因为
  // alias 没有携带完整 metadata 就提前拒绝。只有明确声明不支持时才在这里报错。
  // alias 能力可能是旧目录快照；能力开关交给 ProviderRuntime 的当前元数据与 profile 解析。
  const activeReasoningDisabled = activeModel?.compatibility?.supportsReasoning === false;
  if (config.thinking.enabled && activeReasoningDisabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "enabled"],
      message: `Model ${config.defaultModel} explicitly disables thinking controls.`
    });
  }
  const activeEfforts = activeThinkingLevels
    ? Object.entries(activeThinkingLevels)
      .filter(([level, native]) => level !== "off" && native !== null)
      .map(([level]) => level)
    : activeReasoning?.efforts ?? [];
  if (config.thinking.enabled && activeSupportsReasoning && !activeEfforts.includes(config.thinking.effort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "effort"],
      message: `Model ${config.defaultModel} does not support ${config.thinking.effort} effort.`
    });
  }

  for (const field of ["memoryModel", "rewriteModel", "extractModel"] as const) {
    const memoryAlias = config.context.memory[field];
    if (memoryAlias && !config.models[memoryAlias]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context", "memory", field],
        message: `Unknown memory model alias: ${memoryAlias}`
      });
    }
  }

  const compactionSummaryAlias = config.context.compaction.summaryModel;
  if (compactionSummaryAlias && !config.models[compactionSummaryAlias]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "compaction", "summaryModel"],
      message: `Unknown compaction summary model alias: ${compactionSummaryAlias}`
    });
  }

  const subagentAlias = config.extensions.subagent.model;
  if (subagentAlias) {
    const subagentModel = config.models[subagentAlias];
    if (!subagentModel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Unknown subagent model alias: ${subagentAlias}`
      });
    } else if (subagentModel.supportsTools === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Subagent model ${subagentAlias} does not support tools.`
      });
    }
  }

  if (config.extensions.subagent.maxCostUsd !== undefined) {
    const budgetAlias = subagentAlias ?? config.defaultModel;
    const pricing = config.models[budgetAlias]?.pricing;
    if (
      pricing?.inputPerMillionTokens === undefined
      || pricing.outputPerMillionTokens === undefined
      || pricing.cacheReadPerMillionTokens === undefined
      || pricing.cacheWritePerMillionTokens === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "maxCostUsd"],
        message: `Subagent cost stop thresholds require input, output, cache-read, and cache-write pricing for model ${budgetAlias}.`
      });
    }
  }
});

export const configSchema = z.preprocess(rejectLegacyModelConfig, canonicalConfigSchema);

export type AgentConfig = z.infer<typeof canonicalConfigSchema>;
export type HeartbeatConfig = AgentConfig["heartbeat"];
export type CompactionConfig = AgentConfig["context"]["compaction"];
export type ChatParamsConfig = AgentConfig["chat"];
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type ProviderEmbeddingModelConfig = z.infer<typeof providerEmbeddingModelSchema>;
export type ModelAliasConfig = z.infer<typeof modelAliasSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ThinkingLevelMap = z.infer<typeof thinkingLevelMapSchema>;
export type ModelApiBackend = z.infer<typeof modelApiBackendSchema>;
export type ModelCompatibility = z.infer<typeof modelCompatibilitySchema>;
export type ModelThinkingConfig = z.infer<typeof modelThinkingSchema>;
export type ModelReasoningConfig = z.infer<typeof thinkingSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type ModelLimits = z.infer<typeof modelLimitsSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ExtensionsConfig = z.infer<typeof extensionsSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type CheckpointsConfig = z.infer<typeof checkpointsSchema>;
export type DiagnosticsConfig = z.infer<typeof diagnosticsSchema>;
export type WebFetchConfig = z.infer<typeof webFetchSchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
export type WebCookiesConfig = z.infer<typeof webCookiesSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type { ActivityDataResidency, ActivitySettings, MemoryPolicy };

const defaultWorkspaceIgnore = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".env",
  ".biny",
  ".agent",
  ".DS_Store",
  "PROJECT_DESCRIPTION.local.md",
  "TODO.local.md",
  "ARCHITECTURE.local.md"
];

export const defaultConfig: AgentConfig = {
  format: GLOBAL_CONFIG_FORMAT,
  configVersion: GLOBAL_CONFIG_VERSION,
  needsEmbeddingRebuild: false,
  defaultModel: "deepseek-v4-flash",
  toolModel: undefined,
  providers: {
    deepseek: {
      type: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    }
  },
  models: {
    "deepseek-v4-flash": {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      description: "Fast and affordable model for everyday work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
      reasoning: { efforts: ["low", "high", "max"], defaultEffort: "high", mapping: { low: "low", high: "high", max: "max" } }
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "Frontier model for complex coding, research, and real-world work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      thinkingLevelMap: { off: "none", high: "high", max: "max" },
      reasoning: { efforts: ["high", "max"], defaultEffort: "high", mapping: { high: "high", max: "max" } }
    }
  },
  thinking: { enabled: false, effort: "high" },
  agent: {
    softStepLimit: 32,
    hardStepLimit: 96,
    maxToolCalls: undefined,
    maxRepeatedActions: 3,
    maxConcurrentTools: 4,
    maxQueuedToolCalls: 64
  },
  heartbeat: { enabled: false, intervalMinutes: 30, activeHoursStart: 8, activeHoursEnd: 23 },
  permission: {
    mode: "full-access",
    allowTools: ["Read", "Glob", "Grep", "WebSearch", "save_memory"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    ignore: defaultWorkspaceIgnore
  },
  activity: defaultActivitySettings,
  crystal: {
    passiveEnabled: true,
    semanticScanEnabled: true,
    contour: { count: 4, turns: 3, spread: 2 },
    nucleus: { count: 8, turns: 5, spread: 2 },
    dormantDays: 14
  },
  chat: { cacheMarkers: true, temperature: undefined, maxOutputTokens: undefined, defaultToolSelection: "auto", defaultSkillSelection: "auto", skillExtraction: { enabled: true, minToolCalls: 5 } },
  checkpoints: { enabled: true },
  sandbox: { mode: "off", allowNetwork: true },
  hooks: { beforeTool: [], afterTool: [] },
  diagnostics: {
    enabled: false,
    autoDetect: false,
    autoDetectTimeoutMs: 120_000,
    maxOutputBytes: 8 * 1024,
    commands: []
  },
  context: {
    maxTurnToolResultBytes: 128 * 1024,
    instructionsMaxBytes: 32 * 1024,
    compaction: { enabled: true, reserveTokens: undefined, triggerPercent: undefined, keepRecentTokens: undefined, keepRecentMessages: undefined, maxSummaryTokens: 4_096, summaryModel: undefined },
    identity: { enabled: true, userEnabled: true },
    memory: {
      enabled: true,
      useMemories: true,
      generateMemories: true,
      queryRewrite: true,
      memoryModel: undefined,
      rewriteModel: undefined,
      extractModel: undefined,
      embeddingModel: { kind: "local", model: "multilingual-e5-small" },
      similarityThreshold: 0.1,
      cloudEmbeddingConsents: {},
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
    }
  },
  web: {
    search: {
      enabled: false,
      provider: "anysearch",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 10_000,
      maxResults: 5
    },
    fetch: {
      enabled: false,
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      allowPrivateNetwork: false
    },
    cookies: { enabled: false, path: undefined }
  },
  telemetry: { enabled: false, recordInputs: false, recordOutputs: false },
  extensions: {
    mcp: {},
    skills: [...DEFAULT_PROJECT_SKILL_PATHS],
    skillDefaults: {},
    skillProjectOverrides: {},
    plugins: [],
    globalPlugins: [],
    subagent: {
      enabled: false,
      maxSteps: 16,
      maxOutputTokens: 8_000,
      maxConcurrentSubagents: 2,
      maxPendingSubagents: 16,
      timeoutMs: 300_000,
      model: undefined,
      maxCostUsd: undefined,
      allowedTools: [...defaultSubagentAllowedTools],
      agentPaths: [".biny/agents"]
    }
  }
};

const removedModelIds = new Set(["deepseek-chat", "deepseek-reasoner"]);

/** 目录仍可能返回已下线模型，但它们不应进入普通模型选择器。 */
export function isRemovedModelId(modelId: string): boolean {
  return removedModelIds.has(modelId.toLowerCase());
}

function rejectLegacyModelConfig(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const legacyModel = isRecord(value.model) ? value.model : undefined;
  if (legacyModel && typeof legacyModel.provider === "string" && typeof legacyModel.model === "string") {
    throw new Error(formatRemovedModelConfigPrompt({
      provider: legacyModel.provider,
      model: legacyModel.model,
      reason: "the single `model.provider` / `model.model` configuration shape was removed"
    }));
  }

  const models = isRecord(value.models) ? value.models : {};
  for (const [alias, candidate] of Object.entries(models)) {
    if (!isRecord(candidate) || typeof candidate.model !== "string") continue;
    if (isRemovedModelId(candidate.model) || isRemovedModelId(alias)) {
      throw new Error(formatRemovedModelConfigPrompt({
        alias,
        model: candidate.model,
        reason: `the model ID \`${candidate.model}\` was removed`
      }));
    }
    if ("thinking" in candidate) {
      throw new Error(formatRemovedModelConfigPrompt({
        alias,
        model: candidate.model,
        reason: "the model-level `thinking` field was removed; use `reasoning`"
      }));
    }
  }
  return value;
}

function formatRemovedModelConfigPrompt(details: {
  provider?: string;
  alias?: string;
  model: string;
  reason: string;
}): string {
  const detected = [
    details.provider ? `provider=${JSON.stringify(details.provider)}` : undefined,
    details.alias ? `alias=${JSON.stringify(details.alias)}` : undefined,
    `model=${JSON.stringify(details.model)}`
  ].filter(Boolean).join(", ");
  return [
    "Unsupported model configuration.",
    `Detected: ${detected}.`,
    `Reason: ${details.reason}.`,
    "Biny no longer auto-migrates removed model formats. Update the file manually and retry.",
    "",
    "Required shape:",
    JSON.stringify({
      defaultModel: "coder",
      providers: {
        deepseek: { type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }
      },
      models: {
        coder: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoning: { efforts: ["high", "max"], defaultEffort: "high" }
        }
      }
    }, null, 2),
    "",
    "After editing, run `biny doctor` to validate the configuration."
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
