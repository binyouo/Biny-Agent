/** 桌面结晶操作的输入边界；展示直接复用核心领域类型。 */
import { z } from "zod";
import type { CrystalOverview } from "../agent/context/crystalTypes.js";
import type { CrystalDetail } from "../agent/context/crystalService.js";

const id = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(128);
const name = z.string().trim().min(1).max(120);
export const desktopCrystalRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("overview") }).strict(),
  z.object({ action: z.literal("detail"), id }).strict(),
  z.object({ action: z.literal("seed"), name, sessionId: id.optional() }).strict(),
  z.object({ action: z.literal("type"), id, type: z.enum(["entity", "concept", "claim", "process", "rule", "project"]) }).strict(),
  z.object({ action: z.literal("slot"), id, slot: z.number().int().min(1).max(3).nullable() }).strict(),
  z.object({ action: z.literal("dormant"), id, dormant: z.boolean() }).strict(),
  z.object({ action: z.literal("checklist"), id, fields: z.record(z.string(), z.object({ value: z.string().max(4000), conflict: z.boolean() }).strict()).refine((fields) => Object.keys(fields).length <= 6) }).strict(),
  z.object({ action: z.literal("note"), id, text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ action: z.literal("prefill"), id }).strict(),
  z.object({ action: z.literal("confirm"), id, name: name.optional() }).strict()
]);
export type DesktopCrystalRequest = z.infer<typeof desktopCrystalRequestSchema>;
export interface DesktopCrystalSnapshot {
  overview: CrystalOverview;
  detail?: CrystalDetail & { materialPreviews: Record<number, string> };
}
