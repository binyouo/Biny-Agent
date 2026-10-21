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
export const windowTargetSchema = z.object({ pid: z.number().int().positive().max(2147483647), windowId: z.string().regex(/^[1-9][0-9]{0,19}$/).describe("Exact window ID from ComputerList; preserve as decimal string.") }).strict();
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
export const computerWaitSchema = z.object({ text: z.string().min(1).max(1000), timeoutMs: z.number().int().min(250).max(10_000).default(5_000) }).strict();
export const computerObservationOptions = z.object({
  content: z.enum(["full", "image"]).optional().describe("默认完整观察；image 仅截图并刷新凭据，不提供或沿用控件引用。"),
  waitFor: computerWaitSchema.optional().describe("等待指定文字，默认最多 5 秒；超时后停止，不重复等待相同条件。条件满足只证明文字出现。"),
  maxElements: z.number().int().positive().max(1000).optional(),
  depth: z.number().int().min(1).max(20).optional().describe("AX tree depth, from 1 to 20."),
  screenshotMaxWidth: z.number().int().positive().optional().describe("Downsample width of the screenshot, default 1280."),
  interactiveOnly: z.boolean().optional().describe("Limit to interactive elements. Default true; set false for the full tree."),
}).strict();
export function validateObservationOptions(value: z.infer<typeof computerObservationOptions>, context: z.RefinementCtx): void {
  if (value.waitFor && value.content === "image") context.addIssue({ code: "custom", message: "文字等待需要完整观察，不能使用仅截图模式" });
}
export const windowObserveSchema = windowTargetSchema.extend(computerObservationOptions.shape).superRefine(validateObservationOptions);
export type WindowObserve = z.infer<typeof windowObserveSchema>;
export const computerActionPayload = z.object({
  action: z.enum(["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"]),
  showCursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action."),
  /** physical 先验证整段文本可由当前键盘布局表达；ax 按元素写入。 */
  inputMethod: z.enum(["auto", "physical", "unicode", "ax"]).optional().describe("auto chooses writable AX with a ref, then a complete physical key plan, then Unicode. physical rejects unrepresentable text before input; unicode uses keyboard focus; ax requires an element token."),
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  strategy: z.enum(["auto", "physical", "ax"]).optional(),
  coordinateSpace: z.enum(["screenshot", "screen"]).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  text: z.string().max(4000).optional(), key: z.string().min(1).max(40).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  // 单位是**页**，不是行。一页 = 视口/内容，由守护进程从滚动区量出来（原生目标）；
  // 网页内容量不出页大小，那里会换算成行数并在回执里标注是估算。
  pages: z.number().int().min(1).max(20).optional().describe("Pages to scroll, default 1. Native areas use measured viewport ratios; web areas use estimated wheel notches."),
  x1: z.number().finite().optional(), y1: z.number().finite().optional(),
  x2: z.number().finite().optional(), y2: z.number().finite().optional(),
  value: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
  location: z.number().int().nonnegative().optional().describe("select_text 的 UTF-16 起始偏移。"), length: z.number().int().nonnegative().optional().describe("UTF-16 选区长度，默认零；零表示移动光标。"),
  matchText: z.string().min(1).max(4000).optional().describe("按文字匹配选区，不修改正文；不得与 text/location/length 混用。"), prefix: z.string().max(1000).optional(), suffix: z.string().max(1000).optional(),
  elementToken: z.string().min(1).max(256).optional()
}).strict();
export function validateComputerAction(value: z.infer<typeof computerActionPayload>, context: z.RefinementCtx): void {
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
  if (value.action === "select_text" && (!value.elementToken || (value.text === undefined && value.location === undefined && value.matchText === undefined))) context.addIssue({ code: "custom", message: "select_text requires elementToken and text, location or matchText" });
  if (value.matchText !== undefined && (value.action !== "select_text" || value.text !== undefined || value.location !== undefined || value.length !== undefined)) context.addIssue({ code: "custom", message: "文字匹配选区不能与写入文本或位置选区混用" });
  if ((value.prefix !== undefined || value.suffix !== undefined) && value.matchText === undefined) context.addIssue({ code: "custom", message: "前后文只能用于文字匹配选区" });
}
export const computerActionPayloadSchema = computerActionPayload.superRefine(validateComputerAction);
export const computerActionSchema = computerActionPayload.extend({
  ...windowTargetSchema.shape,
  captureId: z.string().min(1).max(256),
  delivery: z.enum(["background", "foreground"]).default("background")
}).superRefine(validateComputerAction);

export type ComputerAction = z.infer<typeof computerActionSchema>;
export const computerSequenceSchema = windowTargetSchema.extend({
  captureId: z.string().min(1).max(256),
  delivery: z.enum(["background", "foreground"]).default("background"),
  actions: z.array(computerActionSchema.innerType().omit({ pid: true, windowId: true, captureId: true, delivery: true })).min(1).max(5),
}).strict().superRefine((value, context) => {
  for (const [index, step] of value.actions.entries()) {
    const parsed = computerActionSchema.safeParse({ ...step, pid: value.pid, windowId: value.windowId, captureId: value.captureId, delivery: value.delivery });
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: ["actions", index, ...issue.path] });
    if (index > 0 && (!["type_text", "press_key"].includes(step.action) || step.elementToken !== undefined)) context.addIssue({ code: "custom", path: ["actions", index], message: "首步之后只允许向当前焦点输入或按键，不允许沿用控件引用" });
  }
});
export type ComputerSequence = z.infer<typeof computerSequenceSchema>;
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
