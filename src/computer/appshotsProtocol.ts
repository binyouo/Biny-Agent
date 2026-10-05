import { z } from "zod";
export const appshotsSettingsSchema = z.object({
  hotkey: z.string().trim().max(80).default(""), target: z.enum(["current", "new"]).default("current")
}).strict();
export type AppshotsSettings = z.infer<typeof appshotsSettingsSchema>;
export interface AppshotsState { settings: AppshotsSettings; active: boolean; capturing: boolean; error?: string }
export interface AppshotSource { appName: string; bundleId: string; pid: number; windowId: number; title?: string }
export type AppshotEvent = { type: "starting"; id: string; target: AppshotsSettings["target"] } | { type: "captured"; id: string; target: AppshotsSettings["target"]; source: AppshotSource } | { type: "failed"; id: string; error: string };
export interface AppshotsApi {
  state(): Promise<AppshotsState>; settings(value: AppshotsSettings): Promise<AppshotsState>;
  prewarm(): Promise<AppshotsState>; capture(): Promise<AppshotsState>;
  attach(projectId: string, id: string): Promise<{ name: string; path: string; mimeType: string; size: number }>;
  onEvent(listener: (event: AppshotEvent) => void): () => void;
}
export const appshotsIpc = { state: "desktop:appshots:state", settings: "desktop:appshots:settings", prewarm: "desktop:appshots:prewarm", capture: "desktop:appshots:capture", attach: "desktop:appshots:attach", event: "desktop:appshots:event" } as const;
