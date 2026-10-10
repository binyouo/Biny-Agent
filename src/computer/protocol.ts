import { z } from "zod";

export const computerAppSchema = z.object({
  bundleId: z.string().min(1).max(256), appName: z.string().min(1).max(256),
  approvedAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().optional(), useCount: z.number().int().nonnegative().default(0)
}).strict();
export type ComputerAppApproval = z.infer<typeof computerAppSchema>;
export const computerSettingsSchema = z.object({
  enabled: z.boolean().default(true), previewEnabled: z.boolean().default(true), actionLogging: z.boolean().default(false), strictApproval: z.boolean().default(false),
  apps: z.array(computerAppSchema).max(256).default([])
}).strict().refine(value => new Set(value.apps.map(app => app.bundleId)).size === value.apps.length, "Duplicate computer application identity");

export const maxComputerImageBytes = 1024 * 1024;
export const windowTargetSchema = z.object({ pid: z.number().int().positive().max(2147483647), windowId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
export type WindowTarget = z.infer<typeof windowTargetSchema>;
export const computerListSchema = z.object({ pid: windowTargetSchema.shape.pid.optional(), days: z.number().int().min(0).max(90).optional() }).strict();

export const computerMirrorSchema = z.object({
  operation: z.enum(["open", "close", "list"]),
  pid: windowTargetSchema.shape.pid.optional(), windowId: windowTargetSchema.shape.windowId.optional(),
  onMinimize: z.boolean().optional(), all: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (value.operation === "open" && (value.pid === undefined || value.windowId === undefined)) context.addIssue({ code: "custom", message: "mirror open requires pid and windowId" });
  if (value.windowId !== undefined && Number(value.windowId) > 4294967295) context.addIssue({ code: "custom", message: "mirror windowId exceeds the native window ID range" });
  if (value.operation === "close" && !value.all && value.windowId === undefined) context.addIssue({ code: "custom", message: "mirror close requires windowId or all=true" });
  if (value.operation !== "open" && value.onMinimize !== undefined) context.addIssue({ code: "custom", message: "onMinimize is only valid for open" });
  if (value.operation !== "close" && value.all !== undefined) context.addIssue({ code: "custom", message: "all is only valid for close" });
});
export type ComputerMirrorRequest = z.infer<typeof computerMirrorSchema>;

/** 观察选项不属于窗口身份；审批与动作目标只使用 pid/windowId。 */
export const windowObserveSchema = windowTargetSchema.extend({
  maxElements: z.number().int().positive().max(1000).optional(),
  depth: z.number().int().min(1).max(20).optional(),
  screenshotMaxWidth: z.number().int().positive().optional(),
  interactiveOnly: z.boolean().optional(),
});
export type WindowObserve = z.infer<typeof windowObserveSchema>;
export const computerActionSchema = windowTargetSchema.extend({
  action: z.enum(["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"]),
  captureId: z.string().min(1).max(256),
  delivery: z.enum(["background", "foreground"]).default("background"),
  /**
   * 这一次不要动作指示器。对应参照 CLI 的 `--no-cursor`（"hides the lens for one action"）。
   * 守护进程侧的字段名就是 `show_cursor`；早先只有守护进程认识它，四个调用层都没接 ——
   * 能力在、路不通。
   */
  showCursor: z.boolean().optional(),
  /** physical 先验证整段文本可由当前键盘布局表达；ax 按元素写入。 */
  inputMethod: z.enum(["auto", "physical", "unicode", "ax"]).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  strategy: z.enum(["auto", "physical", "ax"]).optional(),
  coordinateSpace: z.enum(["screenshot", "screen"]).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  text: z.string().max(4000).optional(), key: z.string().min(1).max(40).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  // 单位是**页**，不是行。一页 = 视口/内容，由守护进程从滚动区量出来（原生目标）；
  // 网页内容量不出页大小，那里会换算成行数并在回执里标注是估算。
  // 参照的 MCP 契约是 number().int().max(20) —— 页是整数，别让它接受 1.5。
  pages: z.number().int().min(1).max(20).optional(),
  x1: z.number().finite().optional(), y1: z.number().finite().optional(),
  x2: z.number().finite().optional(), y2: z.number().finite().optional(),
  value: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
  location: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
  elementToken: z.string().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (value.action === "click") {
    if (!value.elementToken && (value.x === undefined || value.y === undefined)) context.addIssue({ code: "custom", message: "click requires elementToken or screenshot coordinates" });
    if ((value.x === undefined) !== (value.y === undefined)) context.addIssue({ code: "custom", message: "click coordinates require both x and y" });
  }
  if (value.action === "type_text" && value.text === undefined) context.addIssue({ code: "custom", message: "type_text requires text" });
  if (value.action === "type_text" && value.inputMethod === "ax" && !value.elementToken) context.addIssue({ code: "custom", message: "type_text with inputMethod=ax requires a fresh elementToken" });
  if (value.action === "press_key" && !value.key) context.addIssue({ code: "custom", message: "press_key requires key" });
  if (value.action === "scroll" && (!value.direction || (!value.elementToken && (value.x === undefined || value.y === undefined)) || (value.x === undefined) !== (value.y === undefined))) context.addIssue({ code: "custom", message: "scroll requires direction and an elementToken or complete x/y coordinates" });
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
  onNavigate?(listener: (target: { sessionId?: string; projectId?: string }) => void): () => void;
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
export const computerIpc = { navigate: "desktop:computer:navigate", strict: "desktop:computer:strict", approve: "desktop:computer:approve", revoke: "desktop:computer:revoke", status: "desktop:computer:status", enable: "desktop:computer:enable", control: "desktop:computer:control", preview: "desktop:computer:preview", foreground: "desktop:computer:foreground", logging: "desktop:computer:logging", diagnostics: "desktop:computer:diagnostics", accessibility: "desktop:computer:accessibility", test: "desktop:computer:test" } as const;
