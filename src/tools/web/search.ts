/** 浏览器搜索：Google 与小红书共用受限浏览器读取协议，结果不携带 Cookie。 */
import { z } from "zod";
import type { WebCookiesConfig, WebSearchConfig } from "../../config/schema.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";
import { requestBrowser, type BrowserAutomationEndpoint } from "../browser.js";
import { decodeHtmlEntities } from "./html.js";

const defaultConfig: WebSearchConfig = { enabled: true, provider: "google", visibleBrowsing: false, timeoutMs: 10_000, maxResults: 5 };

const recencyValues = ["day", "week", "month", "year"] as const;
type SearchRecency = (typeof recencyValues)[number];

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
  domains?: string[];
  recency?: SearchRecency;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  favicon?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchConfig["provider"];
  results: WebSearchResult[];
  fetchedAt: string;
}

export function createWebSearchTool(config?: WebSearchConfig, _cookies?: WebCookiesConfig, browser?: BrowserAutomationEndpoint): Tool<WebSearchArgs, WebSearchResponse> {
  const resolvedConfig = config ?? defaultConfig;
  return {
    name: "WebSearch",
    description: "Search the public web and return relevant result links and snippets. Use this for current information, research, news, weather, or facts outside the workspace.",
    promptSnippet: "Search the public web for current information and external facts",
    promptGuidelines: ["Use WebSearch for current public information, research, news, weather, or facts outside the workspace"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query written in natural language." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, description: "Maximum number of results to return." },
        domains: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 }, description: "Optional domains to restrict the search to, such as weather.gov." },
        recency: { type: "string", enum: [...recencyValues], description: "Optional freshness filter: day, week, month, or year." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().positive().max(10).optional(),
      domains: z.array(z.string().min(1)).max(5).optional(),
      recency: z.enum(recencyValues).optional()
    }),
    capability: "web.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: browser ? ToolAccesses.browser(browser.endpoint) : ToolAccesses.none(),
        display: { kind: "generic", summary: args.query, detail: args },
        description: `Search the public web for ${args.query}`,
        approvalRule: `WebSearch(${args.query})`,
        async execute({ signal, onUpdate }) {
          onUpdate?.({ kind: "status", text: "Searching the web" });
          const result = await searchWeb(resolvedConfig, args, browser, signal);
          onUpdate?.({ kind: "status", text: `Found ${String(result.results.length)} result(s)` });
          return result;
        }
      };
    }
  };
}

async function searchWeb(config: WebSearchConfig, args: WebSearchArgs, browser: BrowserAutomationEndpoint | undefined, signal?: AbortSignal): Promise<WebSearchResponse> {
  if (!browser) throw new Error("网络搜索需要连接 Biny Desktop 浏览器，请在桌面端运行此任务。");
  const query = args.query.trim();
  if (!query) throw new Error("WebSearch requires a non-empty query.");
  const maxResults = Math.min(args.maxResults ?? config.maxResults, config.maxResults);
  const url = new URL(config.provider === "google" ? "https://www.google.com/search" : "https://www.xiaohongshu.com/search_result");
  if (config.provider === "google") {
    const domains = (args.domains ?? []).map((domain) => {
      const normalized = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(normalized)) throw new Error("Invalid web search domain.");
      return `site:${normalized}`;
    });
    url.searchParams.set("q", [query, ...domains].join(" "));
    url.searchParams.set("num", String(maxResults * 2));
    if (args.recency) url.searchParams.set("tbs", `qdr:${({ day: "d", week: "w", month: "m", year: "y" })[args.recency]}`);
  } else {
    if (args.domains?.length || args.recency) throw new Error("小红书搜索不支持域名或时间筛选，请移除筛选条件。");
    url.searchParams.set("keyword", query);
    url.searchParams.set("source", "web_search_result_notes");
  }
  const page = await requestBrowser(browser, "web_read", { url: url.href, projectId: browser.projectId, visible: config.visibleBrowsing, timeoutMs: config.timeoutMs, maxBytes: 2 * 1024 * 1024, engine: config.provider }, signal) as { html: string; finalUrl: string };
  if (typeof page?.html !== "string") throw new Error("浏览器返回了无效的搜索页面。");
  if (/consent\.google\.com|\/sorry\/|captcha-form|unusual traffic from your computer/i.test(page.finalUrl + page.html)) throw new Error("Google 需要验证，请在网络搜索设置中打开 Google 设置，完成验证后重试。");
  const results = config.provider === "google" ? parseGoogleResults(page.html, maxResults) : parseXiaohongshuResults(page.html, maxResults);
  if (!results.length && config.provider === "xiaohongshu" && /登录|login|captcha/i.test(page.html)) throw new Error("小红书需要登录或验证，请打开小红书设置完成后重试。");
  return { query, provider: config.provider, results, fetchedAt: new Date().toISOString() };
}

export function parseXiaohongshuResults(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  // 搜索卡片保留带安全参数的链接，避免丢失 xsec_token 导致详情无法打开。
  for (const match of html.matchAll(/<section\b[^>]*class=["'][^"']*note-item[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const card = match[1] ?? "";
    const href = /href=["']([^"']*\/(?:explore|search_result)\/[a-z0-9]+[^"']*)["']/i.exec(card)?.[1];
    if (!href) continue;
    const url = new URL(decodeHtmlEntities(href), "https://www.xiaohongshu.com");
    if (url.hostname !== "www.xiaohongshu.com" || url.protocol !== "https:" || seen.has(url.href)) continue;
    const title = cleanHtmlText(/class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(card)?.[1] ?? card);
    if (!title) continue;
    seen.add(url.href); results.push({ title, url: url.href, snippet: cleanHtmlText(card) });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function parseGoogleResults(html: string, maxResults: number): WebSearchResult[] {
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const matches: Array<{ url: string; title: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const inner = match[3] ?? "";
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
    if (!heading) continue;
    const title = cleanHtmlText(heading[1] ?? "");
    const url = resolveGoogleUrl(match[2] ?? "");
    if (!title || !url) continue;
    matches.push({ url, title, start: match.index, end: anchorPattern.lastIndex });
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const [index, entry] of matches.entries()) {
    if (results.length >= maxResults) break;
    if (seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    const segmentEnd = matches[index + 1]?.start ?? Math.min(entry.end + 2_000, html.length);
    const snippet = cleanHtmlText(html.slice(entry.end, segmentEnd));
    results.push({ title: entry.title, url: entry.url, snippet: snippet || undefined });
  }
  return results;
}

/** 解开 `/url?q=` 跳板，并丢掉 Google 自家的导航链接（登录、设置、缓存快照等）。 */
function resolveGoogleUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded || decoded.startsWith("#")) return undefined;
  let candidate: URL;
  try {
    const parsed = new URL(decoded, "https://www.google.com");
    const redirected = parsed.pathname === "/url" ? parsed.searchParams.get("q") ?? parsed.searchParams.get("url") : undefined;
    candidate = redirected ? new URL(redirected) : parsed;
  } catch {
    return undefined;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return undefined;
  const host = candidate.hostname.toLowerCase();
  if (/(^|\.)google(\.[a-z]{2,3})+$/.test(host) || host.endsWith("googleusercontent.com")) return undefined;
  return candidate.toString();
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 800);
}
