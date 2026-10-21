/** Biny 内置浏览器的本地 Desktop CLI。 */
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { computerDesktopConnection } from "../../computer/desktopActivity.js";
import { requestBrowser, type BrowserAutomationEndpoint } from "../../tools/browser.js";
import { extractReadableHtml } from "../../tools/web/html.js";
import { redactSecrets } from "../../utils/secrets.js";
import { prepareBrowserFile, readBrowserUploadFiles } from "../../browser/transfers.js";

type IabMethod = "list_environments" | "navigate" | "read_dom" | "web_read" | "click" | "fill" | "press"
  | "status" | "back" | "forward" | "reload" | "history" | "screenshot" | "scroll" | "desktop_command"
  | "evaluate" | "cdp" | "viewport" | "upload" | "download" | "export" | "dialog" | "clipboard";

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
  const fileOptions = { workspaceRoot: process.cwd(), ignore: [".git", "node_modules"], deniedPaths: [".env", ".ssh/"] };
  iab.command("eval").argument("<code>", "JavaScript expression in the current page").option("--json", "print JSON")
    .action((code: string, options: { json?: boolean }) => perform("evaluate", { code }, options.json));
  iab.command("cdp").argument("<method>").argument("[params]", "JSON CDP parameters", "{}").option("--json", "print JSON")
    .action(async (method: string, text: string, options: { json?: boolean }) => {
      try {
        let params: unknown;
        try { params = JSON.parse(text); } catch { throw new Error("CDP parameters must contain valid JSON."); }
        await perform("cdp", { method, params }, options.json);
      } catch (error) { printError(error, options.json); }
    });
  const viewport = iab.command("viewport").description("Set or reset page viewport emulation");
  viewport.command("set").argument("<width>", "width in pixels", Number).argument("<height>", "height in pixels", Number)
    .option("--mobile", "emulate a mobile viewport").option("--json", "print JSON")
    .action((width: number, height: number, options: { mobile?: boolean; json?: boolean }) => perform("viewport", { action: "set", width, height, mobile: options.mobile ?? false }, options.json));
  viewport.command("reset").option("--json", "print JSON").action((options: { json?: boolean }) => perform("viewport", { action: "reset" }, options.json));
  iab.command("upload").argument("<selector>").argument("<files...>", "workspace file paths").option("--json", "print JSON")
    .action(async (selector: string, files: string[], options: { json?: boolean }) => {
      try { await perform("upload", { selector, files: await readBrowserUploadFiles(files, fileOptions) }, options.json); }
      catch (error) { printError(error, options.json); }
    });
  for (const method of ["download", "export"] as const) iab.command(method).argument(method === "download" ? "<url>" : "<format>", method === "download" ? "HTTP(S) URL" : "pdf, html, mhtml or md")
    .requiredOption("--out <path>", "new workspace output file").option("--json", "print JSON")
    .action(async (value: string, options: { out: string; json?: boolean }) => {
      try {
        const save = prepareBrowserFile(options.out, fileOptions);
        const result = await save(await send(method, method === "download" ? { url: value } : { format: value }));
        console.log(options.json ? JSON.stringify(result) : result.path);
      } catch (error) { printError(error, options.json); }
    });
  const dialog = iab.command("dialog").description("Watch and answer JavaScript dialogs");
  for (const action of ["watch", "get", "stop", "accept", "dismiss"] as const) {
    const command = dialog.command(action);
    if (action === "accept") command.argument("[text]", "prompt response");
    command.option("--json", "print JSON").action((...values: unknown[]) => {
      const options = values[action === "accept" ? 1 : 0] as { json?: boolean };
      return perform("dialog", { action, text: action === "accept" ? values[0] : undefined }, options.json);
    });
  }
  const clipboard = iab.command("clipboard").description("Read or write Desktop clipboard text");
  clipboard.command("read").option("--json", "print JSON").action((options: { json?: boolean }) => perform("clipboard", { action: "read" }, options.json));
  clipboard.command("write").argument("<text>").option("--json", "print JSON")
    .action((text: string, options: { json?: boolean }) => perform("clipboard", { action: "write", text }, options.json));
  for (const method of ["status", "back", "forward", "reload", "history"] as const) {
    iab.command(method).option("--json", "print JSON").action((options: { json?: boolean }) => perform(method, {}, options.json));
  }
  iab.command("scroll").argument("<y>", "vertical pixels; negative scrolls up", Number)
    .option("--x <pixels>", "horizontal pixels", Number, 0).option("--json", "print JSON")
    .action((y: number, options: { x: number; json?: boolean }) => perform("scroll", { x: options.x, y }, options.json));
  iab.command("screenshot").option("--out <path>", "PNG output file", "biny-browser.png").option("--json", "print JSON")
    .action(async (options: { out: string; json?: boolean }) => {
      try {
        const save = prepareBrowserFile(options.out, fileOptions, true);
        const result = await save(await send("screenshot", {}));
        console.log(options.json ? JSON.stringify(result) : result.path);
      } catch (error) { printError(error, options.json); }
    });
  const environment = iab.command("env").description("Manage browser login environments; use envs to list them");
  for (const action of ["create", "update"] as const) {
    const command = environment.command(action);
    if (action === "update") command.argument("<id>");
    command.requiredOption("--file <path>", "JSON environment {name, proxy}").option("--json", "print JSON")
      .action(async (...values: unknown[]) => {
        const options = values[action === "create" ? 0 : 1] as { file: string; json?: boolean };
        try {
          const text = await readFile(options.file, "utf8");
          let input: unknown;
          try { input = JSON.parse(text); } catch { throw new Error("Browser environment file must contain valid JSON."); }
          await perform("desktop_command", { action: `browser.env.${action}`, id: action === "update" ? values[0] : undefined, input }, options.json);
        }
        catch (error) { printError(error, options.json); }
      });
  }
  for (const action of ["delete", "clear"] as const) environment.command(action).argument("<id>").option("--json", "print JSON")
    .action((id: string, options: { json?: boolean }) => perform("desktop_command", { action: `browser.env.${action}`, id }, options.json));
  environment.command("import-cookies").argument("<source>").argument("<target>").option("--json", "print JSON")
    .action((source: string, target: string, options: { json?: boolean }) => perform("desktop_command", { action: "browser.env.import-cookies", source, target }, options.json));
  const profile = iab.command("profile").description("List or import login profiles from local browsers");
  profile.command("list").option("--json", "print JSON")
    .action((options: { json?: boolean }) => perform("desktop_command", { action: "browser.profile.list" }, options.json));
  profile.command("import").argument("<id>").option("--json", "print JSON")
    .action((id: string, options: { json?: boolean }) => perform("desktop_command", { action: "browser.profile.import", id }, options.json));
  const tab = iab.command("tab").description("Manage the current project's embedded browser tabs");
  tab.command("list").option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON")
    .action((options: { project?: string; json?: boolean }) => perform("desktop_command", { action: "browser.tab.list", workspaceRoot: process.cwd(), projectId: options.project }, options.json));
  tab.command("new").argument("[url]").option("--env <id>", "browser environment ID")
    .option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON")
    .action((url: string | undefined, options: { env?: string; project?: string; json?: boolean }) => perform("desktop_command", {
      action: "browser.tab.action", workspaceRoot: process.cwd(), projectId: options.project, input: { type: "new", url, environmentId: options.env }
    }, options.json));
  for (const action of ["select", "close", "stop", "float"] as const) tab.command(action).argument("<id>")
    .option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON")
    .action((tabId: string, options: { project?: string; json?: boolean }) => perform("desktop_command", {
      action: "browser.tab.action", workspaceRoot: process.cwd(), projectId: options.project, input: { type: action, tabId }
    }, options.json));

  iab.command("click").argument("<selector>", "CSS selector").option("--json", "print JSON")
    .action(async (selector: string, options: { json?: boolean }) => await perform("click", { selector }, options.json));
  iab.command("fill").argument("<selector>", "CSS selector").argument("<value>", "replacement value").option("--json", "print JSON")
    .action(async (selector: string, value: string, options: { json?: boolean }) => await perform("fill", { selector, value }, options.json));
  iab.command("press").argument("<key>", "key name").option("--selector <selector>", "focus this element first").option("--json", "print JSON")
    .action(async (key: string, options: { selector?: string; json?: boolean }) => await perform("press", { key, selector: options.selector }, options.json));

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
      if (json) console.log(JSON.stringify(result ?? null));
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
