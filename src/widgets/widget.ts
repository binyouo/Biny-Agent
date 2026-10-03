import { z } from "zod";
import { disableErrorLogging, parse } from "best-effort-json-parser";

// 不完整模型输入不进入解析器诊断输出，避免把整份内容写入日志。
disableErrorLogging();

export const WIDGET_MAX_HTML_LENGTH = 512_000;
export const widgetSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(1_000).optional(),
  html: z.string().max(WIDGET_MAX_HTML_LENGTH).refine(value => value.trim().length > 0, "Widget HTML is empty.")
}).strict();
export type WidgetInput = z.infer<typeof widgetSchema>;

/** 不完整参数仅用于无脚本预览，不能作为工具准入或成功证据。 */
export function parseWidgetPreview(input: string): Partial<WidgetInput> | undefined {
  if (!input || input.length > WIDGET_MAX_HTML_LENGTH + 8_000) return undefined;
  try {
    const value: unknown = parse(input);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title.slice(0, 160) : undefined,
      description: typeof record.description === "string" ? record.description.slice(0, 1_000) : undefined,
      html: typeof record.html === "string" ? record.html.slice(0, WIDGET_MAX_HTML_LENGTH) : undefined
    };
  } catch { return undefined; }
}

export const WIDGET_GUIDE = `Create a self-contained interactive HTML/SVG fragment for the chat.
Use WidgetRenderer with title, optional description, and html. Keep explanation in the normal response.
Prefer controls (sliders, buttons, next/reset) when they help explain cause and effect. Label controls accessibly.
Use responsive layouts and host tokens: --background, --foreground, --primary, --primary-foreground,
--muted, --muted-foreground, --border, --card, --radius, --chart-1 through --chart-5.
The canvas is transparent. Use 4px spacing increments, restrained controls, and reduced-motion support.
Put inline scripts at the end, after the visual HTML. Scripts run once after successful generation;
streaming previews do not run scripts or event handlers. Use stable element IDs for incremental updates.
No remote dependencies, network requests, local files, storage, or host APIs are available.
Use inline SVG or canvas for charts; embed images as data URLs. Do not import CDN libraries.
sendPrompt(text) offers the user a button to copy a follow-up into the composer; it does not send it.
openLink(url) offers an explicit host button for HTTP(S) links. Keep these actions user initiated.
Keep the essential visualization inline; avoid decorative wrappers and long prose inside widgets.`;
