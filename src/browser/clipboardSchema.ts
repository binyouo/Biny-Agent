import { z } from "zod";

export const maxBrowserClipboardReadCharacters = 20_000;
export const maxBrowserClipboardWriteCharacters = 100_000;
export const maxBrowserClipboardImageBytes = 1024 * 1024;

export const browserClipboardReadSchema = z.object({
  includeImage: z.boolean().optional().describe("Set true only when the user explicitly asks to inspect clipboard image content.")
}).strict();
export const browserClipboardReadResultSchema = z.object({
  text: z.string().max(maxBrowserClipboardReadCharacters),
  truncated: z.boolean(),
  hasImage: z.boolean().optional(),
  imageStatus: z.enum(["available", "too_large"]).optional(),
  imageData: z.string().max(Math.ceil(maxBrowserClipboardImageBytes / 3) * 4).optional()
}).strict().superRefine((result, context) => {
  const hasData = result.imageData !== undefined;
  if (hasData && result.hasImage !== true) context.addIssue({ code: "custom", path: ["imageData"], message: "Image data requires hasImage: true." });
  if (result.imageStatus === "available" && !hasData) context.addIssue({ code: "custom", path: ["imageData"], message: "Available clipboard image data is missing." });
  if (result.imageStatus === "too_large" && hasData) context.addIssue({ code: "custom", path: ["imageData"], message: "Oversized clipboard images must not include image data." });
});
export const browserClipboardWriteSchema = z.object({
  text: z.string().max(maxBrowserClipboardWriteCharacters)
}).strict();
