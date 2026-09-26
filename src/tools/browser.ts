/**
 * 桌面浏览器自动化工具。
 *
 * Agent 运行在 Runtime Host 进程，Electron BrowserWindow 在主进程；两者通过
 * 受令牌保护的 Unix socket 传递少量 JSONL 请求。这里仅维护 Agent 侧协议和工具
 * 定义，浏览器生命周期与 CDP 调用留在 Electron 主进程，避免把 Electron 依赖带入
 * CLI/TUI。
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";
import { redactSensitiveValue } from "../utils/secrets.js";

const requestTimeoutMs = 20_000;
const maxResponseBytes = 4 * 1024 * 1024;

export interface BrowserAutomationEndpoint {
  projectId?: string;
  endpoint: string;
  token: string;
}

interface BrowserAutomationResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserDomSnapshot {
  url: string;
  title: string;
  text: string;
  interactive: Array<{ tag: string; role?: string; name?: string; selector: string }>;
}

interface BrowserNavigateArgs { url: string }
interface BrowserReadDomArgs { maxCharacters?: number }
interface BrowserSelectorArgs { selector: string }
interface BrowserFillArgs { selector: string; value: string }
interface BrowserPressArgs { selector?: string; key: string }

export function createBrowserTools(endpoint: BrowserAutomationEndpoint): Tool[] {
  return [
    createBrowserNavigateTool(endpoint),
    createBrowserReadDomTool(endpoint),
    createBrowserClickTool(endpoint),
    createBrowserFillTool(endpoint),
    createBrowserPressTool(endpoint)
  ];
}

function createBrowserNavigateTool(endpoint: BrowserAutomationEndpoint): Tool<BrowserNavigateArgs> {
  return {
    name: "BrowserOpen",
    description: "Navigate the visible Biny browser to an HTTP or HTTPS URL and return its current page state.",
    promptSnippet: "Navigate the visible browser to a web page",
    promptGuidelines: [
      "Use BrowserOpen before BrowserReadDom when the target page is not already open",
      "Ask for confirmation before navigation that is part of an external side effect; local development pages are safe to inspect"
    ],
    parameters: {
      type: "object",
      properties: { url: { type: "string", minLength: 1, maxLength: 4_096, description: "Absolute HTTP or HTTPS URL." } },
      required: ["url"],
      additionalProperties: false
    },
    schema: z.object({ url: z.string().url().max(4_096) }),
    capability: "browser.navigate",
    risk: "read",
    resolveExecution(args) {
      return browserExecution(endpoint, "navigate", args, `Navigate browser to ${args.url}`);
    }
  };
}

function createBrowserReadDomTool(endpoint: BrowserAutomationEndpoint): Tool<BrowserReadDomArgs> {
  return {
    name: "BrowserReadDom",
    description: "Read the Biny built-in browser page title, URL, text and interactive elements. This does not read the user's Chrome, Edge or other external browser tabs.",
    promptSnippet: "Inspect the Biny built-in browser page",
    promptGuidelines: ["For the user's existing browser or open tabs, use ChromeRelayListTabs then ChromeRelayRead. Never describe a Biny page as the user's daily browser.", "After a page transition or interaction, use BrowserReadDom again to verify the result"],
    parameters: {
      type: "object",
      properties: { maxCharacters: { type: "integer", minimum: 1_000, maximum: 100_000, description: "Maximum readable text characters." } },
      additionalProperties: false
    },
    schema: z.object({ maxCharacters: z.number().int().min(1_000).max(100_000).optional() }),
    capability: "browser.read_dom",
    risk: "read",
    resolveExecution(args) {
      return browserExecution(endpoint, "read_dom", { maxCharacters: args.maxCharacters ?? 24_000 }, "Read the visible browser DOM");
    }
  };
}

function createBrowserClickTool(endpoint: BrowserAutomationEndpoint): Tool<BrowserSelectorArgs> {
  return {
    name: "BrowserClick",
    description: "Click one visible browser element using a CSS selector. Re-read the DOM after the click.",
    promptSnippet: "Click a visible browser element by CSS selector",
    promptGuidelines: ["Use BrowserReadDom to identify a selector; do not guess a destructive button selector"],
    parameters: {
      type: "object",
      properties: { selector: { type: "string", minLength: 1, maxLength: 2_000, description: "CSS selector for the element to click." } },
      required: ["selector"],
      additionalProperties: false
    },
    schema: z.object({ selector: z.string().min(1).max(2_000) }),
    capability: "browser.click",
    risk: "execute",
    resolveExecution(args) {
      return browserExecution(endpoint, "click", args, `Click browser element ${args.selector}`);
    }
  };
}

function createBrowserFillTool(endpoint: BrowserAutomationEndpoint): Tool<BrowserFillArgs> {
  return {
    name: "BrowserType",
    description: "Fill a visible browser input, textarea, or contenteditable element using a CSS selector.",
    promptSnippet: "Fill a browser form field by CSS selector",
    promptGuidelines: ["Treat filling a field as transmitting data; confirm before entering sensitive information into an external site"],
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 2_000, description: "CSS selector for the field." },
        value: { type: "string", maxLength: 100_000, description: "Value to enter." }
      },
      required: ["selector", "value"],
      additionalProperties: false
    },
    schema: z.object({ selector: z.string().min(1).max(2_000), value: z.string().max(100_000) }),
    capability: "browser.fill",
    risk: "execute",
    resolveExecution(args) {
      return browserExecution(endpoint, "fill", args, `Fill browser field ${args.selector}`);
    }
  };
}

function createBrowserPressTool(endpoint: BrowserAutomationEndpoint): Tool<BrowserPressArgs> {
  return {
    name: "BrowserPress",
    description: "Focus an optional browser element and send a key such as Enter, Tab, Escape, or ArrowDown.",
    promptSnippet: "Press a key in the visible browser",
    promptGuidelines: ["Use BrowserReadDom after pressing a key to verify the page state"],
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 2_000, description: "Optional CSS selector to focus first." },
        key: { type: "string", minLength: 1, maxLength: 40, description: "Key name, for example Enter or Escape." }
      },
      required: ["key"],
      additionalProperties: false
    },
    schema: z.object({ selector: z.string().min(1).max(2_000).optional(), key: z.string().min(1).max(40) }),
    capability: "browser.press",
    risk: "execute",
    resolveExecution(args) {
      return browserExecution(endpoint, "press", args, `Press ${args.key} in browser`);
    }
  };
}

function browserExecution(
  endpoint: BrowserAutomationEndpoint,
  method: string,
  args: object,
  description: string
) {
  const detail = args as Record<string, unknown>;
  return {
    // DesktopBrowserService 当前为一个可见 BrowserWindow；只串行化这个浏览器上下文，
    // 不再用 all() 阻塞文件、终端和其它互不相关的工具。
    accesses: ToolAccesses.browser(endpoint.endpoint),
    display: { kind: "generic" as const, summary: description, detail: browserDisplayDetail(method, detail) },
    description,
    approvalRule: `browser_${method}`,
    async execute({ signal }: { signal?: AbortSignal }) {
      return await requestBrowser(endpoint, method, detail, signal);
    }
  };
}

function browserDisplayDetail(method: string, detail: Record<string, unknown>): unknown {
  if (method === "fill") return { selector: detail.selector, value: "[redacted before display]" };
  return redactSensitiveValue(detail);
}

export async function requestBrowser(
  endpoint: BrowserAutomationEndpoint,
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw new Error("Browser action cancelled.");
  const id = randomUUID();
  return await new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(endpoint.endpoint);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Browser automation timed out.")), method === "web_read" && typeof args.timeoutMs === "number" ? args.timeoutMs + 5_000 : requestTimeoutMs);
    const abort = (): void => finish(new Error("Browser action cancelled."));
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) {
        finish(new Error("Browser automation response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line) as BrowserAutomationResponse;
        if (response.id !== id) throw new Error("Browser automation response id mismatch.");
        if (!response.ok) throw new Error(response.error ?? "Browser automation failed.");
        // 浏览器返回值会进入模型上下文；只对返回结果做结构化脱敏，不能改写
        // BrowserType 发送给网页的真实值。
        finish(undefined, redactSensitiveValue(response.result));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("close", () => { if (!settled) finish(new Error("Browser connection closed before a result.")); });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: endpoint.token, method, args })}\n`);
    });
  });
}
