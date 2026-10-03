const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml", "image/x-icon"]);
const maximumImageCharacters = Math.ceil(8 * 1024 * 1024 / 3) * 4;

/** 仅展示工具明确返回的图片；省略的二进制元信息不推断为可读取资源。 */
export function toolResultImages(result: unknown): { images: string[]; caption?: string } | undefined {
  if (!isRecord(result)) return undefined;
  const images: string[] = [];
  const addImage = (value: unknown, mime: unknown, base64: boolean): void => {
    if (typeof value !== "string" || typeof mime !== "string" || !imageTypes.has(mime.toLowerCase()) || images.length >= 8) return;
    let source = value;
    if (base64) {
      if (value.length < 16 || value.length > maximumImageCharacters || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return;
      source = `data:${mime.toLowerCase()};base64,${value}`;
    } else if (value.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
      if (!match || !imageTypes.has(match[1]!.toLowerCase()) || match[2]!.length > maximumImageCharacters) return;
    } else {
      try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol)) return;
      } catch { return; }
    }
    if (!images.includes(source)) images.push(source);
  };
  const mime = result.mime_type ?? result.mediaType ?? result.mimeType ?? "image/jpeg";
  addImage(result.image_base64 ?? result.thumbBase64, mime, true);
  if (!images.length) addImage(result.image_url ?? result.imageUrl, mime, false);
  let caption = typeof result.content === "string" ? result.content : typeof result.revised_prompt === "string" ? result.revised_prompt : undefined;
  if (!images.length && Array.isArray(result.content)) {
    const texts: string[] = [];
    // 读取数量有界，防止未知扩展的超长结果拖慢时间线。
    for (const part of result.content.slice(0, 128)) {
      if (!isRecord(part)) continue;
      if (part.type === "image") addImage(part.data, part.mimeType ?? "image/jpeg", true);
      else if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
    caption = texts.join("\n\n") || undefined;
  }
  return images.length ? { images, caption } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
