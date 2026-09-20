/**
 * biny:// 深链解析。
 *
 * 模型按提示词协议在回复里输出 biny:// 链接；渲染层只认这三种目标，
 * 解析失败（伪造 id、缺参数、编码损坏）一律返回 undefined，调用方静默忽略。
 */
export type BinyDeepLink =
  | { kind: "compose"; text: string }
  | { kind: "settings" }
  | { kind: "session"; sessionId: string };

export function parseBinyDeepLink(url: string): BinyDeepLink | undefined {
  if (!url.startsWith("biny://")) return undefined;
  const rest = url.slice("biny://".length);
  if (rest === "settings") return { kind: "settings" };
  const queryIndex = rest.indexOf("?");
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : rest.slice(queryIndex + 1));
  if (path === "compose") {
    const text = (params.get("text") ?? "").trim();
    return text ? { kind: "compose", text } : undefined;
  }
  if (path === "session") {
    const sessionId = params.get("s")?.trim();
    return sessionId ? { kind: "session", sessionId } : undefined;
  }
  return undefined;
}

type DeepLinkHandler = (url: string) => void;

let handler: DeepLinkHandler | undefined;

/** App 挂载时注册路由；MarkdownContent 的叶子渲染直接调用，不必层层传 props。 */
export function setDeepLinkHandler(value: DeepLinkHandler | undefined): void {
  handler = value;
}

export function openDeepLink(url: string): void {
  handler?.(url);
}
