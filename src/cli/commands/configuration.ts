import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { executeConfigurationCommand } from "../../config/commands.js";
import { globalConfigDir } from "../../config/paths.js";
import { createFileConfigStore } from "../../config/store.js";
import { requestDesktopCommand } from "./desktop.js";

export function registerConfigurationCommands(program: Command, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const configRoot = globalConfigDir();
  const execute = async (action: string, input: Record<string, unknown>, json?: boolean): Promise<void> => {
    // safeStorage 凭据由 Desktop 进程解密；普通文件配置仍使用共享的本地配置存储。
    const value = existsSync(path.join(configRoot, "credentials.enc"))
      ? await requestDesktopCommand("configuration", { operation: action, input })
      : await executeConfigurationCommand(createFileConfigStore(configRoot), action, input);
    console.log(JSON.stringify(value, null, json ? undefined : 2));
  };
  const config = program.command("config").description("Read and update global settings");
  config.command("get").argument("[path]", "dot-separated setting; omit for global Agent configuration")
    .option("--json", "print JSON").action((key: string | undefined, options: { json?: boolean }) => wrap(async () => {
      if (key && desktopPreferencePath(key)) {
        console.log(JSON.stringify(await requestDesktopCommand("preferences.get", { path: key }), null, options.json ? undefined : 2));
      } else await execute("config.get", { path: key }, options.json);
    })());
  config.command("set").argument("<path>", "dot-separated setting").argument("<value>", "JSON value, or unquoted text")
    .option("--json", "print JSON").action((key: string, raw: string, options: { json?: boolean }) => wrap(async () => {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { value = raw; }
      if (desktopPreferencePath(key)) {
        console.log(JSON.stringify(await requestDesktopCommand("preferences.set", { path: key, value }), null, options.json ? undefined : 2));
      } else await execute("config.set", { path: key, value }, options.json);
    })());
  const provider = program.command("provider").description("Manage configured Provider connections");
  provider.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(async () => await execute("provider.list", {}, options.json))());
  provider.command("add").argument("<alias>").requiredOption("--file <path>", "JSON Provider configuration file")
    .option("--json", "print JSON").action((alias: string, options: { file: string; json?: boolean }) => wrap(async () => {
      const text = await readFile(options.file, "utf8");
      let definition: unknown;
      try { definition = JSON.parse(text); } catch { throw new Error("Provider configuration file must contain valid JSON."); }
      await execute("provider.add", { alias, definition }, options.json);
    })());
  provider.command("remove").argument("<alias>").option("--json", "print JSON")
    .action((alias: string, options: { json?: boolean }) => wrap(async () => await execute("provider.remove", { alias }, options.json))());
  const model = program.command("model").description("List models and select the global default");
  model.command("list").option("--provider <alias>", "filter one Provider").option("--json", "print JSON")
    .action((options: { provider?: string; json?: boolean }) => wrap(async () => await execute("model.list", { provider: options.provider }, options.json))());
  model.command("set").argument("<alias>", "configured or catalog model alias").option("--json", "print JSON")
    .action((alias: string, options: { json?: boolean }) => wrap(async () => await execute("model.set", { alias }, options.json))());
}

function desktopPreferencePath(key: string): boolean {
  return ["themePreference", "appearancePreference", "fontPreference"].includes(key.split(".")[0]!);
}
