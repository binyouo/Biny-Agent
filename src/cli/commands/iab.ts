/** Biny 内置浏览器的本地 Desktop CLI。 */
import type { Command } from "commander";
import { computerDesktopConnection } from "../../computer/desktopActivity.js";
import { requestBrowser, type BrowserAutomationEndpoint } from "../../tools/browser.js";
import { extractReadableHtml } from "../../tools/web/html.js";
import { redactSecrets } from "../../utils/secrets.js";

type IabMethod = "list_environments" | "navigate" | "read_dom" | "web_read";

export interface InAppBrowserCliDependencies {
  connection(): Promise<{ endpoint: string; token: string } | undefined>;
  request(endpoint: BrowserAutomationEndpoint, method: IabMethod, args: Record<string, unknown>): Promise<unknown>;
}

const defaultDependencies: InAppBrowserCliDependencies = {
  connection: computerDesktopConnection,
  request: requestBrowser
};

export function registerInAppBrowserCommands(program: Command, dependencies = defaultDependencies): void {
  const iab = program.command("iab").description("Use Biny Desktop's built-in browser");

  iab.command("envs").description("List browser login environments").option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      await perform("list_environments", {}, options.json);
    });

  iab.command("info").description("Read the current built-in browser page").option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      await perform("read_dom", { maxCharacters: 24_000 }, options.json);
    });

  iab.command("goto").description("Open a page in the built-in browser")
    .argument("<url>", "HTTP(S) URL")
    .option("--env <name>", "open in a named browser environment")
    .option("--json", "print JSON")
    .action(async (url: string, options: { env?: string; json?: boolean }) => {
      try {
        if (url.length > 4_096) throw new Error("地址超过 4096 个字符。");
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("只支持 HTTP 或 HTTPS 地址。");
        await perform("navigate", { url: target.href, environment: options.env }, options.json);
      } catch (error) { printError(error, options.json); }
    });

  iab.command("fetch").description("Read pages using a built-in browser login environment")
    .argument("<urls...>", "HTTP(S) URLs")
    .option("--env <name>", "use a named browser environment")
    .option("--html", "print HTML instead of readable text")
    .option("--json", "print JSON")
    .action(async (urls: string[], options: { env?: string; html?: boolean; json?: boolean }) => {
      try {
        const pages: Array<{ url: string; finalUrl: string; title?: string; status: number; content: string; truncatedAtByteLimit: boolean }> = [];
        for (const url of urls) {
          if (url.length > 4_096) throw new Error("地址超过 4096 个字符。");
          const target = new URL(url);
          if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("只支持 HTTP 或 HTTPS 地址。");
          const result = await send("web_read", {
            url: target.href,
            environment: options.env,
            timeoutMs: 15_000,
            maxBytes: 512 * 1024,
            maxRedirects: 5,
            allowPrivateNetwork: false
          });
          const page = asFetchedPage(result);
          const content = options.html || !page.contentType.toLowerCase().includes("html")
            ? (options.html ? page.html : page.body)
            : (await extractReadableHtml(page.html, page.finalUrl)).text;
          pages.push({ url: target.href, finalUrl: page.finalUrl, title: page.title || undefined, status: page.status, content, truncatedAtByteLimit: page.truncatedAtByteLimit });
        }
        if (options.json) console.log(JSON.stringify(pages));
        else for (const page of pages) console.log(`${page.title ? `# ${page.title}\n` : ""}${page.finalUrl}\n\n${page.content}`);
      } catch (error) { printError(error, options.json); }
    });

  async function perform(method: IabMethod, args: Record<string, unknown>, json?: boolean): Promise<void> {
    try {
      const result = await send(method, args);
      if (json) console.log(JSON.stringify(result));
      else if (method === "list_environments" && Array.isArray(result)) {
        console.log(result.map((item, index) => {
          const environment = item as { name?: unknown; id?: unknown };
          return `${index + 1}. ${String(environment.name ?? "未知")}  ${String(environment.id ?? "")}`;
        }).join("\n"));
      } else if (method === "read_dom") {
        const page = result as { title?: unknown; url?: unknown; text?: unknown };
        console.log(`${String(page.title ?? "")}\n${String(page.url ?? "")}\n\n${String(page.text ?? "")}`.trim());
      } else console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } catch (error) { printError(error, json); }
  }

  async function send(method: IabMethod, args: Record<string, unknown>): Promise<unknown> {
    const connection = await dependencies.connection();
    if (!connection) throw new InAppBrowserUnavailableError();
    return await dependencies.request(connection, method, args);
  }
}

interface FetchedPage {
  body: string;
  contentType: string;
  finalUrl: string;
  html: string;
  status: number;
  title: string;
  truncatedAtByteLimit: boolean;
}

function asFetchedPage(value: unknown): FetchedPage {
  if (!value || typeof value !== "object") throw new Error("内置浏览器返回了无效页面结果。");
  const page = value as Partial<FetchedPage>;
  if (typeof page.finalUrl !== "string" || typeof page.body !== "string" || typeof page.html !== "string" || typeof page.status !== "number") {
    throw new Error("内置浏览器返回了不完整的页面结果。");
  }
  return {
    body: page.body,
    contentType: typeof page.contentType === "string" ? page.contentType : "",
    finalUrl: page.finalUrl,
    html: page.html,
    status: page.status,
    title: typeof page.title === "string" ? page.title : "",
    truncatedAtByteLimit: page.truncatedAtByteLimit === true
  };
}

class InAppBrowserUnavailableError extends Error {
  readonly code = "unavailable";
  constructor() { super("请先启动 Biny Desktop，再使用内置浏览器 CLI。"); }
}

function printError(error: unknown, json?: boolean): void {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const code = error instanceof InAppBrowserUnavailableError ? error.code : "request_failed";
  if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
  else console.error(message);
  process.exitCode = 1;
}
