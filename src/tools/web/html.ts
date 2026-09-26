/**
 * HTML 转纯文本模块。
 *
 * Readability 负责识别文章正文；识别失败时用轻量文本转换保住短页和非文章页的可读内容。
 * 返回给模型的始终是文本，不暴露网页提供的 HTML。
 */
const strippedBlocks = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const lineBreakTags = /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi;
const listItemTags = /<li\b[^>]*>/gi;

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(strippedBlocks, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(lineBreakTags, "\n")
      .replace(listItemTags, "\n- ")
      .replace(/<[^>]*>/g, "")
  )
    // 逐行收紧空白，再把三行以上的空行压成一个段落间隔。
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ReadableHtmlDocument {
  title?: string;
  text: string;
}

/** 在无脚本、无子资源加载的 DOM 中提取正文，解析失败时保留原来的纯文本回退。 */
export async function extractReadableHtml(html: string, url: string): Promise<ReadableHtmlDocument> {
  const fallback = { title: htmlTitle(html), text: htmlToText(html) };
  if (!html.trim()) return fallback;

  // 只有实际读取 HTML 时才载入 DOM 与正文提取依赖，避免拖慢 CLI/Desktop 启动。
  const [{ Readability }, { JSDOM }] = await Promise.all([
    import("@mozilla/readability"),
    import("jsdom")
  ]);
  let closeDom: (() => void) | undefined;
  try {
    const dom = new JSDOM(html, { url });
    closeDom = () => dom.window.close();
    const article = new Readability(dom.window.document).parse();
    const text = normalizeReadableText(article?.textContent ?? "");
    if (!text) return fallback;
    const title = article?.title?.replace(/\s+/g, " ").trim() || fallback.title;
    return { title, text };
  } catch {
    // 网页 HTML 不可信且可能畸形；Readability 失败时继续返回不含标签的旧式文本结果。
    return fallback;
  } finally {
    closeDom?.();
  }
}

function normalizeReadableText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = match?.[1] === undefined ? "" : decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
  return title || undefined;
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const numeric = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}
