import { z } from "zod";

export const activityDataResidencySchema = z.enum(["local", "external"]);

/** 配置缺失 activity 段时的完整默认值；schema 默认也引用它，避免两份字面量漂移。 */
export const defaultActivitySettings = {
  enabled: true,
  captureDebounceMs: 4_000,
  heartbeatMs: 120_000,
  idleTimeoutMs: 30_000,
  inputPauseMs: 1_200,
  visualPollMs: 12_000,
  browserPollIntervalMs: 12_000,
  jpegQuality: 55,
  histogramChangeThreshold: 0.05,
  pixelDiffThreshold: 0.02,
  pixelTolerance: 30,
  ocrEnabled: true,
  inputMonitoringEnabled: true,
  ocrLanguages: ["en-US", "zh-Hans", "zh-Hant", "ja"],
  ocrEveryNFrames: 3,
  sensitiveApplications: [
    "com.apple.keychainaccess",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal"
  ],
  maxStorageMb: 10_240,
  outputDirectory: "~/.biny/agent/activity-records",
};

interface ActivitySettingsNormalizationFields {
  captureDebounceMs: number;
  heartbeatMs: number;
  idleTimeoutMs: number;
  inputPauseMs: number;
  visualPollMs: number;
  browserPollIntervalMs: number;
  jpegQuality: number;
  ocrEveryNFrames: number;
}

/** 运行时对时间间隔和 JPEG/OCR 参数做的归一化；设置文件也必须共享这一规则。 */
function normalizeActivitySettingsValue<T extends ActivitySettingsNormalizationFields>(value: T): T {
  const requiredInterval = (current: number, fallback: number, minimum: number): number =>
    Math.max(minimum, Math.round(current || fallback));
  const optionalInterval = (current: number, minimum: number): number =>
    current > 0 ? Math.max(minimum, Math.round(current)) : 0;
  return {
    ...value,
    captureDebounceMs: requiredInterval(value.captureDebounceMs, 4_000, 3_000),
    heartbeatMs: requiredInterval(value.heartbeatMs, 120_000, 60_000),
    idleTimeoutMs: requiredInterval(value.idleTimeoutMs, 30_000, 10_000),
    inputPauseMs: requiredInterval(value.inputPauseMs, 1_200, 800),
    visualPollMs: optionalInterval(value.visualPollMs, 10_000),
    browserPollIntervalMs: optionalInterval(value.browserPollIntervalMs, 10_000),
    jpegQuality: Math.max(30, Math.min(95, Math.round(value.jpegQuality || 55))),
    ocrEveryNFrames: Math.max(1, Math.min(20, Math.round(value.ocrEveryNFrames || 3)))
  } as T;
}

/** 已从设置里删除、但旧配置文件仍可能携带的键；解析前剥离，避免 .strict() 拒绝旧配置。 */
const deprecatedActivitySettingKeys = new Set(["activityRecallEnabled", "analysisModel", "externalPolicy", "externalConfirmed", "analysisPolicy", "analysisExternalConfirmed"]);

function stripDeprecatedActivitySettings(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of deprecatedActivitySettingKeys) delete record[key];
  return record;
}

const activitySettingsObjectSchema = z.object({
  /** 首次启动即开启，用户仍可在设置页一键暂停。 */
  enabled: z.boolean().default(true),
  captureDebounceMs: z.number().int().min(0).max(30_000).default(4_000),
  heartbeatMs: z.number().int().min(0).max(300_000).default(120_000),
  idleTimeoutMs: z.number().int().min(0).max(600_000).default(30_000),
  inputPauseMs: z.number().int().min(0).max(5_000).default(1_200),
  visualPollMs: z.number().int().min(0).max(30_000).default(12_000),
  /** 前台浏览器（Safari/Chrome/Edge）当前标签 URL+标题的轮询间隔；0 表示关闭浏览器标签采集。 */
  browserPollIntervalMs: z.number().int().min(0).max(600_000).default(12_000),
  jpegQuality: z.number().int().min(0).max(100).default(55),
  /** 整屏截图缩略图的直方图变化阈值；用于过滤画面没有实质变化的帧。 */
  histogramChangeThreshold: z.number().min(0).max(1).default(0.05),
  /** 整屏截图缩略图的像素变化比例阈值。 */
  pixelDiffThreshold: z.number().min(0).max(1).default(0.02),
  /** 判断像素变化时允许的每通道误差。 */
  pixelTolerance: z.number().int().min(0).max(255).default(30),
  ocrEnabled: z.boolean().default(true),
  inputMonitoringEnabled: z.boolean().default(true),
  ocrLanguages: z.array(z.string().trim().min(2).max(32)).min(1).max(16).default(["en-US", "zh-Hans", "zh-Hant", "ja"]),
  ocrEveryNFrames: z.number().int().min(0).max(20).default(3),
  sensitiveApplications: z.array(z.string().trim().min(1).max(256)).max(256).default([
    "com.apple.keychainaccess",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "org.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal"
  ]),
  maxStorageMb: z.number().int().min(100).max(200_000).default(10_240),
  outputDirectory: z.string().trim().min(1).max(2_048).default("~/.biny/agent/activity-records"),
}).strict();

export const activitySettingsInputSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema
).transform(normalizeActivitySettingsValue);

/** 设置页即时更新只接受局部字段；完整归一化在与当前配置合并后再执行。 */
export const activitySettingsPatchSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema.partial()
);

export const activitySettingsSchema = z.preprocess(
  stripDeprecatedActivitySettings,
  activitySettingsObjectSchema
).transform(normalizeActivitySettingsValue).default(defaultActivitySettings);

export type ActivityDataResidency = z.infer<typeof activityDataResidencySchema>;
export type ActivitySettings = z.infer<typeof activitySettingsSchema>;
export type ActivitySettingsInput = ActivitySettings;
export type ActivitySettingsPatch = Partial<ActivitySettingsInput>;
