import { z } from "zod";

export const cuaVersion = "0.30.4";
export const maxComputerImageBytes = 1024 * 1024;
export const windowTargetSchema = z.object({ pid: z.number().int().positive().max(2147483647), windowId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
export type WindowTarget = z.infer<typeof windowTargetSchema>;
export const computerActionSchema = windowTargetSchema.extend({
  action: z.enum(["click", "type_text", "press_key", "scroll"]),
  captureId: z.string().min(1).max(256),
  delivery: z.enum(["background", "foreground"]).default("background"),
  x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(),
  text: z.string().max(4000).optional(), key: z.string().min(1).max(40).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(10).optional(),
  elementToken: z.string().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (value.action === "click" && (value.x === undefined || value.y === undefined)) context.addIssue({ code: "custom", message: "click requires screenshot coordinates" });
  if (value.action === "type_text" && (!value.elementToken || value.text === undefined)) context.addIssue({ code: "custom", message: "type_text requires a fresh elementToken and text" });
  if (value.action === "press_key" && !value.key) context.addIssue({ code: "custom", message: "press_key requires key" });
  if (value.action === "scroll" && (!value.elementToken || !value.direction)) context.addIssue({ code: "custom", message: "scroll requires elementToken and direction" });
});
export type ComputerAction = z.infer<typeof computerActionSchema>;
export const computerImageSchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg"]), dataBase64: z.string().max(Math.ceil(maxComputerImageBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export type ComputerImage = z.infer<typeof computerImageSchema>;
export type ComputerState = "disabled" | "ready" | "paused" | "taken-over" | "unknown";
export interface ComputerStatus { state: ComputerState; owner?: string; preview: boolean; foregroundAllowed: boolean; actionLogging?: boolean; lastOutcome: "not-dispatched" | "completed" | "refused" | "unverified" | "unknown"; diagnostic?: string }
export type ComputerPermissionState = "granted" | "denied" | "unknown";
export interface ComputerAuditEntry { at: number; action: ComputerAction["action"]; target: WindowTarget; outcome: ComputerStatus["lastOutcome"]; durationMs: number }
export interface ComputerActionLimit { action: ComputerAction["action"]; code: string; message: string }
export interface ComputerDiagnostics {
  workerPath: string; hostPath: string; expectedVersion: string; driverVersion?: string;
  sdkLoaded: boolean; runtimeReady: boolean;
  permissions: { accessibility: ComputerPermissionState; screenRecording: ComputerPermissionState };
  /** Biny permits each invocation separately; there are no persistent app grants. */
  approvals: Array<{ bundleId: string; appName: string }>;
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
}
export const computerIpc = { status: "desktop:computer:status", enable: "desktop:computer:enable", control: "desktop:computer:control", preview: "desktop:computer:preview", foreground: "desktop:computer:foreground", logging: "desktop:computer:logging", diagnostics: "desktop:computer:diagnostics", accessibility: "desktop:computer:accessibility", test: "desktop:computer:test" } as const;
