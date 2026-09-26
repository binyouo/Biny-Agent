/** 浏览器连接的文本/JSON CLI，与模型工具共享同一个本地服务。 */
import type { Command } from "commander";
import { requestBrowserRelay } from "../../browser/relayClient.js";
import { prepareBrowserExtension } from "../../browser/extensionAssets.js";
import { BrowserRelayError, type RelayMethod } from "../../browser/relayProtocol.js";
import { redactSecrets } from "../../utils/secrets.js";
import { transferBrowserFile } from "../../browser/transfers.js";

export function registerBrowserCommands(program: Command): void {
  const browser = program.command("browser").description("Connect and use existing browser tabs");
  const fail = (error: unknown, json?: boolean): void => {
    const code = error instanceof BrowserRelayError ? error.code : "unavailable";
    const message = error instanceof BrowserRelayError ? redactSecrets(error.message) : "浏览器连接操作失败，请检查 Desktop 服务和扩展安装目录。";
    if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
    else console.error(message);
    process.exitCode = 1;
  };
  const perform = async (method: RelayMethod, args: unknown, json?: boolean): Promise<void> => {
    try { const result = await requestBrowserRelay(method, args); console.log(JSON.stringify(result, null, json ? undefined : 2)); }
    catch (error) { fail(error, json); }
  };
  for (const method of ["status", "tabs"] as const) browser.command(method).option("--json", "print JSON").action((options: { json?: boolean }) => perform(method, {}, options.json));
  browser.command("read").argument("<browser-id>").argument("<tab-id>").option("--json", "print JSON")
    .action((browserId: string, tabId: string, options: { json?: boolean }) => perform("read", { browserId, tabId: Number(tabId) }, options.json));
  for (const method of ["navigate", "click", "fill", "press"] as const) {
    const command = browser.command(method).argument("<browser-id>").argument("<tab-id>").argument("<value>", method === "navigate" ? "HTTP(S) URL" : method === "press" ? "key" : "CSS selector");
    if (method === "fill") command.argument("<text>");
    command.option("--json", "print JSON").action(async (...values: unknown[]) => {
      const [browserId, tabId, value] = values;
      const options = values[method === "fill" ? 4 : 3] as { json?: boolean };
      const args: Record<string, unknown> = { browserId, tabId: Number(tabId) };
      if (method === "navigate") args.url = value;
      else if (method === "press") args.key = value;
      else args.selector = value;
      if (method === "fill") args.value = values[3];
      await perform(method, args, options.json);
    });
  }
  // 结构化入口覆盖框架、等待与文件操作，和工具使用同一协议及文件边界。
  browser.command("act").argument("<method>", "read, navigate, click, fill, press, screenshot, scroll, wait, upload, download")
    .requiredOption("--args <json>", "operation parameters; files use workspace-relative paths")
    .option("--json", "print JSON").action(async (method: string, options: { args: string; json?: boolean }) => {
      try {
        if (!["read", "navigate", "click", "fill", "press", "screenshot", "scroll", "wait", "upload", "download"].includes(method)) throw new BrowserRelayError("invalid", "不支持的浏览器操作。");
        let args: unknown;
        try { args = JSON.parse(options.args); } catch { throw new BrowserRelayError("invalid", "--args 必须为 JSON 对象。"); }
        const result = method === "screenshot" || method === "upload" || method === "download"
          ? await transferBrowserFile(method, args, { workspaceRoot: process.cwd(), ignore: [".git", "node_modules"], deniedPaths: [".env", ".ssh/"] })
          : await requestBrowserRelay(method as RelayMethod, args);
        console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      } catch (error) { fail(error, options.json); }
    });
  browser.command("setup").option("--json", "print JSON").action(async (options: { json?: boolean }) => {
    try {
      const extensionPath = await prepareBrowserExtension();
      const instructions = "在 Chrome 扩展管理中开启开发者模式，加载此目录。Biny 设置 → 浏览器 → 复制配对地址，再粘贴到扩展设置。";
      console.log(options.json ? JSON.stringify({ extensionPath, instructions }) : `${extensionPath}\n${instructions}`);
    } catch (error) { fail(error, options.json); }
  });
}
