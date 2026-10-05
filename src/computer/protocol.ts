import { z } from "zod";

export const computerAppSchema = z.object({
  bundleId: z.string().min(1).max(256), appName: z.string().min(1).max(256),
  approvedAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().optional(), useCount: z.number().int().nonnegative().default(0)
}).strict();
export type ComputerAppApproval = z.infer<typeof computerAppSchema>;
export const computerSettingsSchema = z.object({
  enabled: z.boolean().default(false), strictApproval: z.boolean().default(false),
  apps: z.array(computerAppSchema).max(256).default([])
}).strict().refine(value => new Set(value.apps.map(app => app.bundleId)).size === value.apps.length, "Duplicate computer application identity");

export const maxComputerImageBytes = 1024 * 1024;
export const windowTargetSchema = z.object({ pid: z.number().int().positive().max(2147483647), windowId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
export type WindowTarget = z.infer<typeof windowTargetSchema>;
export const computerActionSchema = windowTargetSchema.extend({
  action: z.enum(["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"]),
  captureId: z.string().min(1).max(256),
  delivery: z.enum(["background", "foreground"]).default("background"),
  x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
  text: z.string().max(4000).optional(), key: z.string().min(1).max(40).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  // 单位是**页**，不是行。一页 = 视口/内容，由守护进程从滚动区量出来（原生目标）；
  // 网页内容量不出页大小，那里会换算成行数并在回执里标注是估算。
  pages: z.number().positive().max(20).optional(),
  x1: z.number().finite().nonnegative().optional(), y1: z.number().finite().nonnegative().optional(),
  x2: z.number().finite().nonnegative().optional(), y2: z.number().finite().nonnegative().optional(),
  value: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
  location: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
  elementToken: z.string().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (value.action === "click" && (value.x === undefined || value.y === undefined)) context.addIssue({ code: "custom", message: "click requires screenshot coordinates" });
  if (value.action === "type_text" && (!value.elementToken || value.text === undefined)) context.addIssue({ code: "custom", message: "type_text requires a fresh elementToken and text" });
  if (value.action === "press_key" && !value.key) context.addIssue({ code: "custom", message: "press_key requires key" });
  if (value.action === "scroll" && (!value.elementToken || !value.direction)) context.addIssue({ code: "custom", message: "scroll requires elementToken and direction" });
  if (value.action === "drag" && (value.x1 === undefined || value.y1 === undefined || value.x2 === undefined || value.y2 === undefined)) context.addIssue({ code: "custom", message: "drag requires x1, y1, x2 and y2" });
  if (value.action === "perform_secondary_action" && !value.elementToken && (value.x === undefined || value.y === undefined)) context.addIssue({ code: "custom", message: "perform_secondary_action requires elementToken or screenshot coordinates" });
  if (value.action === "set_value" && (!value.elementToken || value.value === undefined)) context.addIssue({ code: "custom", message: "set_value requires elementToken and value" });
  if (value.action === "select_text" && (!value.elementToken || (value.text === undefined && value.location === undefined))) context.addIssue({ code: "custom", message: "select_text requires elementToken and either text or location" });
});
export type ComputerAction = z.infer<typeof computerActionSchema>;
export const computerImageSchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg"]), dataBase64: z.string().max(Math.ceil(maxComputerImageBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export type ComputerImage = z.infer<typeof computerImageSchema>;
export type ComputerState = "disabled" | "ready" | "paused" | "taken-over" | "unknown";
export interface ComputerStatus { state: ComputerState; owner?: string; preview: boolean; foregroundAllowed: boolean; actionLogging?: boolean; lastOutcome: "not-dispatched" | "completed" | "refused" | "unverified" | "unknown"; diagnostic?: string }
export type ComputerPermissionState = "granted" | "denied" | "unknown";
export interface ComputerAuditEntry {
  at: number; action: ComputerAction["action"]; target: WindowTarget;
  outcome: ComputerStatus["lastOutcome"]; durationMs: number;
  /** 哪个应用被操作了 —— 事后翻日志时第一个想知道的就是它。 */
  bundleId?: string;
  /** 失败时的结构化错误码。 */
  errorCode?: string;
}
export interface ComputerActionLimit { action: ComputerAction["action"]; code: string; message: string }
export interface ComputerDiagnostics {
  workerPath: string; hostPath: string; expectedVersion: string; driverVersion?: string; uptimeSeconds?: number;
  /** 助手二进制是否真的在磁盘上；与「已加载」是两件事。 */
  helperPresent?: boolean;
  /** 焦点守卫是否武装成功；未武装时动作可能把用户前台窗口带走。 */
  focusGuard?: "armed" | "unavailable";
  sdkLoaded: boolean; runtimeReady: boolean;
  permissions: { accessibility: ComputerPermissionState; screenRecording: ComputerPermissionState };
  strictApproval: boolean;
  approvals: ComputerAppApproval[];
  audit: ComputerAuditEntry[]; error?: string;
  actionLimits?: ComputerActionLimit[];
}
export interface ComputerPreview { image: ComputerImage; target: WindowTarget; capturedAt: number }
export type ComputerControl = "pause" | "resume" | "takeover" | "stop";
export interface ComputerDesktopApi {
  status(): Promise<ComputerStatus>;
  enable(): Promise<ComputerStatus>;
  control(control: ComputerControl): Promise<ComputerStatus>;
  preview(enabled: boolean): Promise<ComputerStatus>;
  foreground(enabled: boolean): Promise<ComputerStatus>;
  logging(enabled: boolean): Promise<ComputerStatus>;
  diagnostics(): Promise<ComputerDiagnostics>;
  requestAccessibility(): Promise<ComputerDiagnostics>;
  testSetup(): Promise<ComputerDiagnostics>;
  strict(enabled: boolean): Promise<ComputerDiagnostics>;
  approve(bundleId: string): Promise<ComputerDiagnostics>;
  revoke(bundleId: string): Promise<ComputerDiagnostics>;
}
export const computerIpc = { strict: "desktop:computer:strict", approve: "desktop:computer:approve", revoke: "desktop:computer:revoke", status: "desktop:computer:status", enable: "desktop:computer:enable", control: "desktop:computer:control", preview: "desktop:computer:preview", foreground: "desktop:computer:foreground", logging: "desktop:computer:logging", diagnostics: "desktop:computer:diagnostics", accessibility: "desktop:computer:accessibility", test: "desktop:computer:test" } as const;
