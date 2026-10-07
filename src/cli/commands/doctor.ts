/**
 * 环境诊断命令模块。
 *
 * `doctor` 做轻量本地检查，报告 Node、pnpm、git、配置文件和 `.biny` 目录状态，并验证当前项目的有效配置。
 * 它只读取环境，不创建或修改项目文件。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "../../config/loader.js";
import { globalAgentDir, globalConfigPath, projectSettingsPath } from "../../config/paths.js";
import { pathExists } from "../../utils/fs.js";

const execFileAsync = promisify(execFile);

export async function doctorCommand(workspaceRoot: string): Promise<void> {
  // doctor 只做本地环境探测，不创建配置或 session。
  const checks = [
    ["node", process.version],
    ["pnpm", await commandVersion("pnpm", ["--version"])],
    ["git", await commandVersion("git", ["--version"])],
    [globalConfigPath(), (await pathExists(globalConfigPath())) ? "found" : "missing"],
    [projectSettingsPath(workspaceRoot), (await pathExists(projectSettingsPath(workspaceRoot))) ? "found" : "missing"],
    ["ignored legacy config", await legacyConfigStatus(workspaceRoot)],
    [".biny", (await pathExists(path.join(workspaceRoot, ".biny"))) ? "found" : "missing"]
  ];

  for (const [name, result] of checks) {
    console.log(`${name}: ${result}`);
  }
  const config = await loadConfig(workspaceRoot).catch((error: unknown) => {
    throw new Error(configurationErrorMessage(error));
  });
  console.log("configuration: valid");
  console.log(`credentials: ${Object.values(config.providers).some((provider) => Boolean(provider.apiKey))
    ? `warning: inline API key found in ${CONFIG_FILE}; use apiKeyEnv and rotate the key`
    : "no inline API keys"}`);
}

function configurationErrorMessage(error: unknown): string {
  // 解析器错误可能包含配置值或 JSON 片段；诊断只显示固定的来源和检查方向。
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Invalid project .biny/settings.json:")) {
    return "Invalid project .biny/settings.json. Check JSON syntax and supported field values.";
  }
  if (message.startsWith("Failed to load project .biny/settings.json:")) {
    return "Unable to read project .biny/settings.json. Check file access, file type and size.";
  }
  if (message.startsWith("Project defaultModel ")) {
    return "Project .biny/settings.json defaultModel must reference a model configured in global config.json.";
  }
  if (message.startsWith("Failed to load config.json:")) {
    return "Unable to read or validate global config.json. Check file access, JSON syntax, supported field values and model references.";
  }
  return "Invalid effective configuration. Check field values and model references in global config.json and project .biny/settings.json.";
}

async function legacyConfigStatus(workspaceRoot: string): Promise<string> {
  const projectPath = path.join(workspaceRoot, CONFIG_FILE);
  const desktopPath = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Biny", "workspaces", "default", CONFIG_FILE)
    : path.join(globalAgentDir(), "..", "workspaces", "default", CONFIG_FILE);
  if (await pathExists(projectPath)) return `found at ${projectPath}; ignored and not loaded`
  if (await pathExists(desktopPath)) return `found at ${desktopPath}; ignored and not loaded`;
  return "none";
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  // 缺失的外部命令以 not available 呈现，避免把 ENOENT 堆栈暴露给用户。
  try {
    const result = await execFileAsync(command, args);
    return result.stdout.trim();
  } catch {
    return "not available";
  }
}
