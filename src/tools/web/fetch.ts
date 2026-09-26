/**
 * 网页抓取工具模块。
 *
 * `WebSearch` 只能拿到摘要；给定一个 URL（文档页、issue、RFC）时模型需要读到正文。
 * 抓取本身是把一个任意出网请求交给模型，所以目标地址必须先过 `addressPolicy` 的校验，
 * 跳转也要逐跳重新校验 —— 一次跳到 `169.254.169.254` 就能读到云实例凭证。
 */
import { requestBrowser, type BrowserAutomationEndpoint } from "../browser.js";
import { z } from "zod";
import type { WebCookiesConfig, WebFetchConfig } from "../../config/schema.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";
import { assertFetchableUrl, type HostnameResolver } from "./addressPolicy.js";
import { cookieHeaderFor, defaultCookieJarPath, readCookieJar, type StoredCookie } from "./cookieJar.js";
import { extractReadableHtml } from "./html.js";

const defaultLength = 24_000;
const maxLength = 200_000;

export interface WebFetchArgs {
  url: string;
  offset?: number;
  length?: number;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;
  totalCharacters: number;
  offset: number;
  content: string;
  hasMore: boolean;
  truncatedAtByteLimit: boolean;
}

export interface WebFetchDependencies {
  browser?: BrowserAutomationEndpoint;
  visibleBrowsing?: boolean;
  resolveHostname?: HostnameResolver;
}

export function createWebFetchTool(
  config?: WebFetchConfig,
  cookies?: WebCookiesConfig,
  dependencies?: WebFetchDependencies
): Tool<WebFetchArgs, WebFetchResult> {
  const timeoutMs = config?.timeoutMs ?? 15_000;
  const maxBytes = config?.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = config?.maxRedirects ?? 5;
  const allowPrivateNetwork = config?.allowPrivateNetwork ?? false;
  const cookieJarPath = cookies?.enabled === false ? undefined : cookies?.path ?? defaultCookieJarPath();
  return {
    name: "WebFetch",
    description: `Fetch a public http(s) URL and return its readable text. HTML pages use article extraction with a plain-text fallback. Returns at most ${String(maxLength)} characters; page through longer documents with offset.`,
    promptSnippet: "Fetch readable text from a public HTTP or HTTPS URL",
    promptGuidelines: ["Use WebFetch to inspect a known URL and page through truncated documents with offset"],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "Absolute http or https URL to fetch." },
        offset: { type: "integer", minimum: 0, description: "Character offset into the extracted text. Defaults to 0." },
        length: { type: "integer", minimum: 1, maximum: maxLength, description: `Characters to return. Defaults to ${String(defaultLength)}.` }
      },
      required: ["url"],
      additionalProperties: false
    },
    schema: z.object({
      url: z.string().min(1).max(4_096),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(maxLength).optional()
    }),
    capability: "web.fetch",
    risk: "read",
    resolveExecution(args) {
      const target = parseUrl(args.url);
      return {
        accesses: dependencies?.browser ? ToolAccesses.browser(dependencies.browser.endpoint) : ToolAccesses.none(),
        display: { kind: "generic", summary: "Fetch web page", detail: target.toString() },
        description: `Fetch ${target.toString()}`,
        approvalRule: `WebFetch(${target.origin})`,
        async execute({ signal }) {
          const jar = !dependencies?.browser && cookieJarPath ? await readCookieJar(cookieJarPath) : [];
          const fetched = dependencies?.browser
            ? await requestBrowser(dependencies.browser, "web_read", { url: target.href, projectId: dependencies.browser.projectId, visible: dependencies.visibleBrowsing, timeoutMs, maxBytes, maxRedirects, allowPrivateNetwork }, signal) as BrowserFetchedDocument
            : await fetchDocument(target, {
            timeoutMs,
            maxBytes,
            maxRedirects,
            allowPrivateNetwork,
            jar,
            resolveHostname: dependencies?.resolveHostname
          }, signal);
          const readable = isHtml(fetched.contentType)
            ? await extractReadableHtml(fetched.body, fetched.finalUrl)
            : { title: undefined, text: fetched.body };
          const text = readable.text;
          const offset = Math.min(args.offset ?? 0, text.length);
          const content = text.slice(offset, offset + (args.length ?? defaultLength));
          const truncatedAtByteLimit = "truncatedAtByteLimit" in fetched
            ? fetched.truncatedAtByteLimit
            : fetched.truncated;
          return {
            url: args.url,
            finalUrl: fetched.finalUrl,
            status: fetched.status,
            contentType: fetched.contentType,
            title: readable.title,
            totalCharacters: text.length,
            offset,
            content,
            hasMore: offset + content.length < text.length,
            truncatedAtByteLimit
          };
        }
      };
    }
  };
}

interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowPrivateNetwork: boolean;
  resolveHostname?: HostnameResolver;
  /** 共享 cookie jar 的内容；每一跳按当跳地址重新匹配，jar 为空即等于不带 cookie。 */
  jar: StoredCookie[];
}

interface FetchedDocument {
  finalUrl: string;
  status: number;
  contentType?: string;
  body: string;
  truncated: boolean;
}

interface BrowserFetchedDocument {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncatedAtByteLimit: boolean;
}

async function fetchDocument(url: URL, limits: FetchLimits, signal?: AbortSignal): Promise<FetchedDocument> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  const abort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    let current = url;
    for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
      await assertFetchableUrl(current, {
        allowPrivateNetwork: limits.allowPrivateNetwork,
        resolveHostname: limits.resolveHostname
      });
      const headers: Record<string, string> = {
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "Biny/WebFetch"
      };
      // Cookie 按当前这一跳的地址重新匹配：跳到别的域名时不能把上一跳的登录凭据带过去。
      const cookie = cookieHeaderFor(limits.jar, current);
      if (cookie) headers.cookie = cookie;
      // 手动处理跳转：交给 fetch 自动跟随就没有机会校验中间跳板的地址。
      const response = await fetch(current, {
        redirect: "manual",
        headers,
        signal: controller.signal
      });
      const location = response.headers.get("location");
      if (isRedirectStatus(response.status) && location) {
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        // 与上面的跳转分支一样先取消 body，否则未消费的响应体会一直挂到 GC。
        await response.body?.cancel();
        throw new Error(`Fetching ${current.toString()} returned HTTP ${String(response.status)}.`);
      }
      const { text, truncated } = await readBounded(response, limits.maxBytes);
      return {
        finalUrl: current.toString(),
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        body: text,
        truncated
      };
    }
    throw new Error(`Fetching ${url.toString()} exceeded ${String(limits.maxRedirects)} redirects.`);
  } catch (error) {
    if (timedOut) throw new Error(`Fetching ${url.toString()} timed out after ${String(limits.timeoutMs)}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Content-Length 是可以撒谎的，所以按实际读到的字节数收口。WebSearch 也复用这个上限读取。 */
export async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (total >= maxBytes) truncated = true;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks, total).toString("utf8"), truncated };
}

function parseUrl(value: string): URL {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error(`Not an absolute URL: ${value}`);
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isHtml(contentType: string | undefined): boolean {
  return Boolean(contentType && /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType));
}
