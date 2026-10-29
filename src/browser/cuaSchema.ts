import { z } from "zod";

const coordinate = z.number().finite().min(0).max(8_192);
const modifiers = z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4);

export const browserCuaSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), x: coordinate, y: coordinate }).strict(),
  z.object({ action: z.literal("doubleClick"), x: coordinate, y: coordinate }).strict(),
  z.object({ action: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z.object({ action: z.literal("scroll"), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-10_000).max(10_000).default(0), deltaY: z.number().finite().min(-10_000).max(10_000) }).strict(),
  z.object({ action: z.literal("type"), text: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal("keypress"), key: z.string().trim().min(1).max(100), modifiers }).strict()
]);

export const browserDomSnapshotSchema = z.object({}).strict();

export const browserDomActionSchema = z.object({
  snapshotId: z.string().uuid(),
  ref: z.string().regex(/^e[1-9]\d{0,2}$/u),
  action: z.discriminatedUnion("m", [
    z.object({ m: z.literal("click") }).strict(),
    z.object({ m: z.literal("type"), text: z.string().max(100_000) }).strict(),
    z.object({ m: z.literal("press"), key: z.string().trim().min(1).max(100) }).strict()
  ])
}).strict();

export type BrowserCuaArgs = z.infer<typeof browserCuaSchema>;
export type BrowserDomActionArgs = z.infer<typeof browserDomActionSchema>;
