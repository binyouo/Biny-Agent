/**
 * Runtime / Task / Automation / Goal / Graph / Daemon 管理命令。
 *
 * 这些命令不直接打开 SQLite，也不创建第二套状态；它们统一 attach 到当前 workspace
 * 的 Unix-socket Runtime Host。没有 owner 时才按现有 Host 规则启动 detached owner。
 */
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { connectOrSpawnRuntimeHost, connectRuntimeHost, runtimeHostPaths, type RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { runRuntimeHostProcess } from "../../runtime/hostProcess.js";
import { agentDir, ensureAgentDirs } from "../../session/store.js";
import type { AutomationCreateInput } from "../../runtime/AutomationScheduler.js";
import type { GraphNodeInput } from "../../runtime/GoalGraphStore.js";

const execFile = promisify(execFileCallback);

interface JsonOption {
  json?: boolean;
}

interface HostActionOptions extends JsonOption {
  noSpawn?: boolean;
}

export async function daemonInstallCommand(workspaceRoot: string): Promise<void> {
  ensureMac("LaunchAgent");
  await ensureAgentDirs(workspaceRoot);
  const paths = runtimeHostPaths(workspaceRoot);
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  const label = `com.biny.runtime.${paths.rootHash}`;
  const plistPath = path.join(launchAgents, `${label}.plist`);
  await fs.mkdir(launchAgents, { recursive: true, mode: 0o700 });
  const programArguments = runtimeHostProgramArguments(workspaceRoot);
  const plist = launchAgentPlist(label, programArguments, workspaceRoot);
  await fs.writeFile(plistPath, plist, { mode: 0o600 });
  const domain = `gui/${String(process.getuid?.() ?? "")}`;
  await launchctlIgnoreFailure(["bootout", domain, plistPath]);
  await execFile("/bin/launchctl", ["bootstrap", domain, plistPath]);
  await execFile("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`]);
  console.log(JSON.stringify({ installed: true, label, plistPath, endpoint: paths.endpoint }));
}

export async function daemonUninstallCommand(workspaceRoot: string): Promise<void> {
  ensureMac("LaunchAgent");
  const paths = runtimeHostPaths(workspaceRoot);
  const label = `com.biny.runtime.${paths.rootHash}`;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${String(process.getuid?.() ?? "")}`;
  await launchctlIgnoreFailure(["bootout", domain, plistPath]);
  await fs.rm(plistPath, { force: true });
  console.log(JSON.stringify({ installed: false, label, plistPath }));
}

export async function daemonStatusCommand(workspaceRoot: string): Promise<void> {
  ensureMac("LaunchAgent");
  const paths = runtimeHostPaths(workspaceRoot);
  const label = `com.biny.runtime.${paths.rootHash}`;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const registration = await readJsonFile(paths.registrationPath);
  let loaded = false;
  try {
    await execFile("/bin/launchctl", ["print", `gui/${String(process.getuid?.() ?? "")}/${label}`]);
    loaded = true;
  } catch {
    loaded = false;
  }
  console.log(JSON.stringify({ installed: await fileExists(plistPath), loaded, label, plistPath, endpoint: paths.endpoint, registration }));
}

export async function daemonRunCommand(workspaceRoot: string): Promise<void> {
  await runRuntimeHostProcess([
    "--workspace-root", workspaceRoot,
    "--persistence-root", workspaceRoot
  ]);
}

export async function automationListCommand(workspaceRoot: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationList());
}

export async function automationCreateCommand(workspaceRoot: string, input: AutomationCreateInput, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationCreate(input));
}

export async function automationPauseCommand(workspaceRoot: string, automationId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationPause(automationId));
}

export async function automationResumeCommand(workspaceRoot: string, automationId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationResume(automationId));
}

export async function automationRunCommand(workspaceRoot: string, automationId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationRun(automationId));
}

export async function automationPendingCommand(workspaceRoot: string, automationId: string | undefined, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationPending(automationId));
}

export async function automationDeleteCommand(workspaceRoot: string, automationId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.automationDelete(automationId));
}

export async function taskCreateCommand(
  workspaceRoot: string,
  task: string,
  options: JsonOption & { sessionId?: string; parentRunId?: string; verification?: string } = {}
): Promise<void> {
  const verification = options.verification === undefined ? undefined : JSON.parse(options.verification) as unknown;
  const payload = verification === undefined ? task : { prompt: task, verification };
  await hostAction(workspaceRoot, options, async (client) => await client.taskCreate({ task: payload, sessionId: options.sessionId, parentRunId: options.parentRunId }));
}

export async function taskActionCommand(workspaceRoot: string, action: "start" | "run" | "cancel" | "approve" | "resume" | "retry", taskRunId: string, options: JsonOption & { reason?: string; retrySafety?: string } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => {
    if (action === "start") return await client.taskStart(taskRunId, { retrySafety: options.retrySafety });
    if (action === "run") return await client.taskRun(taskRunId, { retrySafety: options.retrySafety });
    if (action === "cancel") return await client.taskCancel(taskRunId, options.reason);
    if (action === "approve") return await client.taskApprove(taskRunId);
    if (action === "resume") return await client.taskResume(taskRunId);
    return await client.taskRetry(taskRunId);
  });
}

export async function taskGetCommand(workspaceRoot: string, taskRunId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskGet(taskRunId));
}

export async function taskListCommand(workspaceRoot: string, options: JsonOption & { status?: string; limit?: number } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskList({ status: options.status, limit: options.limit }));
}

export async function taskEventsCommand(workspaceRoot: string, taskRunId: string, options: JsonOption & { limit?: number } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskEvents(taskRunId, options.limit));
}

export async function goalCreateCommand(workspaceRoot: string, title: string, options: JsonOption & { payload?: string; goalId?: string } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.goalCreate(title, parseJsonOption(options.payload), options.goalId));
}

export async function goalListCommand(workspaceRoot: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.goalList());
}

export async function goalActionCommand(workspaceRoot: string, action: "get" | "pause" | "resume" | "cancel", goalId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => {
    if (action === "get") return await client.goalGet(goalId);
    if (action === "pause") return await client.goalPause(goalId);
    if (action === "resume") return await client.goalResume(goalId);
    return await client.goalCancel(goalId);
  });
}

export async function graphCreateCommand(workspaceRoot: string, options: JsonOption & { goalId?: string; graphId?: string; nodes: string; payload?: string } ): Promise<void> {
  const parsedNodes = JSON.parse(options.nodes) as unknown;
  if (!Array.isArray(parsedNodes)) throw new Error("--nodes must be a JSON array.");
  await hostAction(workspaceRoot, options, async (client) => await client.graphCreate({ goalId: options.goalId, graphId: options.graphId, nodes: parsedNodes as GraphNodeInput[], payload: parseJsonOption(options.payload) }));
}

export async function graphListCommand(workspaceRoot: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.graphList());
}

export async function graphActionCommand(workspaceRoot: string, action: "start" | "pause" | "resume" | "cancel" | "inspect" | "events", graphId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => {
    if (action === "start") return await client.graphStart(graphId);
    if (action === "pause") return await client.graphPause(graphId);
    if (action === "resume") return await client.graphResume(graphId);
    if (action === "cancel") return await client.graphCancel(graphId);
    if (action === "inspect") return await client.graphInspect(graphId);
    return await client.graphEvents(graphId);
  });
}

async function hostAction<T>(workspaceRoot: string, options: HostActionOptions, action: (client: RuntimeHostClient) => Promise<T>): Promise<void> {
  const client = options.noSpawn
    ? await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` })
    : await connectOrSpawnRuntimeHost(workspaceRoot, {
      workspaceRoot,
      surface: "cli",
      clientId: `cli-${process.pid}`,
      resumeInterrupted: false
    });
  if (!client) throw new Error("Runtime Host is not running. Start it with `biny daemon run` or omit --no-spawn.");
  try {
    const result = await action(client);
    const visible = unwrapHostOperationResult(result);
    // commander 布尔选项不传时是 undefined（不是 false）：默认人类可读输出，--json 输出紧凑 JSON。
    console.log(options.json ? JSON.stringify(visible) : formatPlain(visible));
  } finally {
    await client.close();
  }
}

function unwrapHostOperationResult(value: unknown): unknown {
  if (!isHostOperationResult(value)) return value;
  if (!value.accepted) throw new Error(value.reason ?? "Runtime operation was rejected.");
  return value.result;
}

function isHostOperationResult(value: unknown): value is { accepted: boolean; result?: unknown; reason?: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accepted === "boolean";
}

function parseJsonOption(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(value) as unknown;
}

function formatPlain(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function ensureMac(feature: string): void {
  if (process.platform !== "darwin") throw new Error(`${feature} is only available on macOS.`);
}

async function launchctlIgnoreFailure(args: string[]): Promise<void> {
  try { await execFile("/bin/launchctl", args); } catch { /* 未加载时 bootout 本来就会失败。 */ }
}

function runtimeHostProgramArguments(workspaceRoot: string): string[] {
  const script = path.resolve(process.argv[1] ?? "");
  const args = ["runtime-host", "--workspace-root", workspaceRoot, "--persistence-root", workspaceRoot];
  return script.endsWith(".ts")
    ? [process.execPath, "--import", "tsx", script, ...args]
    : [process.execPath, script, ...args];
}

function launchAgentPlist(label: string, programArguments: string[], workspaceRoot: string): string {
  const xml = programArguments.map((argument) => `<string>${escapeXml(argument)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array>${xml}</array><key>WorkingDirectory</key><string>${escapeXml(workspaceRoot)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Interactive</string><key>StandardOutPath</key><string>${escapeXml(path.join(agentDir(workspaceRoot), "daemon.stdout.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(path.join(agentDir(workspaceRoot), "daemon.stderr.log"))}</string></dict></plist>\n`;
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown; } catch { return undefined; }
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
