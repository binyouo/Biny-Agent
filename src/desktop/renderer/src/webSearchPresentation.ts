/**
 * WebSearch 工具结果的桌面端展示投影。
 *
 * 纯函数模块：把工具的 args/result 转换为搜索卡片视图模型，
 * 供 ToolActivity 渲染，也供 tests/desktop.test.ts 直接断言。
 */

export interface WebSearchResultView {
  title: string;
  url: string;
  /** 展示用域名（去掉 www. 前缀）。 */
  domain: string;
  snippet?: string;
  /** 依次尝试的站点图标地址；全部失败后渲染首字母徽标。 */
  faviconCandidates: string[];
  fallbackLetter: string;
}

export interface WebSearchView {
  query: string;
  providerLabel?: string;
  results: WebSearchResultView[];
  fetchedAt?: string;
}

const providerLabels: Record<string, string> = {
  duckduckgo: "DuckDuckGo",
  google: "Google",
  xiaohongshu: "小红书",
  tavily: "Tavily",
  brave: "Brave Search",
  anysearch: "AnySearch"
};

export function projectWebSearchView(args: unknown, result: unknown): WebSearchView {
  const argsRecord = asRecord(args);
  const resultRecord = asRecord(result);
  const query = stringOf(resultRecord?.query) ?? stringOf(argsRecord?.query) ?? "";
  const provider = stringOf(resultRecord?.provider);
  const rawResults = Array.isArray(resultRecord?.results) ? resultRecord.results : [];
  return {
    query,
    providerLabel: provider ? providerLabels[provider] ?? provider : undefined,
    results: rawResults.map(projectResult).filter((item): item is WebSearchResultView => item !== undefined),
    fetchedAt: stringOf(resultRecord?.fetchedAt)
  };
}

function projectResult(value: unknown): WebSearchResultView | undefined {
  const record = asRecord(value);
  const title = stringOf(record?.title);
  const url = stringOf(record?.url);
  if (!title || !url) return undefined;
  const parsed = parseHttpUrl(url);
  if (!parsed) return undefined;
  const domain = parsed.hostname.replace(/^www\./i, "");
  return {
    title,
    url: parsed.toString(),
    domain,
    snippet: stringOf(record?.snippet),
    faviconCandidates: faviconCandidates(parsed.hostname, stringOf(record?.favicon)),
    fallbackLetter: (domain.charAt(0) || "?").toUpperCase()
  };
}

/**
 * 图标回退链：provider 自带 favicon → DuckDuckGo 图标服务 → Google s2。
 * favicon 由结果站点自行控制，只放行 https，避免渲染端向明文地址发请求。
 */
function faviconCandidates(hostname: string, favicon: string | undefined): string[] {
  const candidates = [
    favicon && parseHttpUrl(favicon)?.protocol === "https:" ? favicon : undefined,
    `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`
  ];
  return [...new Set(candidates.filter((value): value is string => value !== undefined))];
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
