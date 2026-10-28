import { z } from "zod";

export const browserDialogAutoReplySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("arm"), behavior: z.enum(["accept", "dismiss"]), text: z.string().max(10_000).optional() }).strict()
    .refine(args => args.behavior === "accept" || args.text === undefined, "Only accepted prompt dialogs can include response text."),
  z.object({ action: z.literal("stop") }).strict()
]);

export type BrowserDialogAutoReplyArgs = z.infer<typeof browserDialogAutoReplySchema>;
