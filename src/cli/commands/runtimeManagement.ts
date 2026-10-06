/**
 * Runtime / Task / Automation / Goal / Graph / Daemon 管理命令。
 *
 * 写操作统一 attach 到 workspace 的 Runtime Host；会话目标查询读取同一持久投影，
 * 不因查看目标启动 owner 或继续后台执行。
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
import { GoalGraphStore, type GraphNodeInput } from "../../runtime/GoalGraphStore.js";
import { RuntimeEventAuthority } from "../../runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../../runtime/SessionGoalStore.js";

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

export async function taskActionCommand(workspaceRoot: string, action: "start" | "run" | "cancel" | "approve" | "resume" | "retry", taskRunId: string, options: JsonOption & { reason?: string; retrySafety?: string; approvalId?: string } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => {
    if (action === "start") return await client.taskStart(taskRunId, { retrySafety: options.retrySafety });
    if (action === "run") return await client.taskRun(taskRunId, { retrySafety: options.retrySafety });
    if (action === "cancel") return await client.taskCancel(taskRunId, options.reason);
    if (action === "approve") {
      if (!options.approvalId) throw new Error("task approve requires --approval-id from the current needs_approval result.");
      return await client.taskApprove(taskRunId, options.approvalId);
    }
    if (action === "resume") return await client.taskResume(taskRunId);
    return await client.taskRetry(taskRunId);
  });
}

export async function taskGetCommand(workspaceRoot: string, taskRunId: string, options: JsonOption = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskGet(taskRunId));
}

export async function taskMessageCommand(workspaceRoot: string, taskRunId: string, message: string, options: JsonOption & { session: string; messageId?: string }): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskMessage(taskRunId, options.session, message, options.messageId));
}

export async function taskWaitCommand(workspaceRoot: string, taskRunId: string, options: JsonOption & { session: string; waitMs?: number; afterRevision?: number }): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskWait(taskRunId, options.session, options.waitMs, options.afterRevision));
}

export async function taskListCommand(workspaceRoot: string, options: JsonOption & { status?: string; limit?: number; cursor?: number } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskList({ status: options.status, limit: options.limit, cursor: options.cursor }));
}

export async function taskEventsCommand(workspaceRoot: string, taskRunId: string, options: JsonOption & { limit?: number } = {}): Promise<void> {
  await hostAction(workspaceRoot, options, async (client) => await client.taskEvents(taskRunId, options.limit));
}

export async function sessionGoalSetCommand(workspaceRoot: string, objective: string, options: JsonOption & { session?: string; tokenBudget?: number } = {}): Promise<void> {
  const sessionId = requireGoalSession(options.session);
  if (!objective.trim()) throw new Error("Goal objective must not be empty.");
  if (options.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)) throw new Error("Goal token budget must be a positive safe integer.");
  await hostAction(workspaceRoot, options, async (client) => {
    const goal = await client.sessionGoalGet(sessionId);
    return await client.sessionGoalSet(sessionId, objective, { tokenBudget: options.tokenBudget, expected: goal === undefined ? undefined : { goalId: goal.goalId, revision: goal.revision } });
  });
}

export async function sessionGoalActionCommand(workspaceRoot: string, action: "show" | "pause" | "resume" | "clear", options: JsonOption & { session?: string } = {}): Promise<void> {
  const sessionId = requireGoalSession(options.session);
  if (action === "show") {
    let record;
    if (await fileExists(path.join(agentDir(workspaceRoot), "runtime.sqlite"))) {
      const authority = await RuntimeEventAuthority.open(workspaceRoot, { backfillLegacySessions: false });
      try {
        const goals = await SessionGoalStore.open(workspaceRoot, authority);
        try { record = goals.get(sessionId); }
        finally { goals.close(); }
      } finally { authority.close(); }
    }
    console.log(options.json ? JSON.stringify(record ?? null) : record === undefined ? "No goal for this session." : formatPlain(record));
    return;
  }
  await hostAction(workspaceRoot, options, async (client) => {
    const goal = await client.sessionGoalGet(sessionId);
    const expected = goal === undefined ? undefined : { goalId: goal.goalId, revision: goal.revision };
    if (action === "pause") return await client.sessionGoalPause(sessionId, expected);
    if (action === "resume") return await client.sessionGoalResume(sessionId, expected);
    const cleared = await client.sessionGoalClear(sessionId, expected);
    return cleared.accepted ? { ...cleared, result: { sessionId, cleared: true } } : cleared;
  });
}

function requireGoalSession(sessionId?: string): string {
  if (!sessionId?.trim()) throw new Error("A session goal requires --session <id>.");
  return sessionId.trim();
}

export async function graphCreateCommand(workspaceRoot: string, options: JsonOption & { graphId?: string; nodes: string; payload?: string } ): Promise<void> {
  const parsedNodes = JSON.parse(options.nodes) as unknown;
  if (!Array.isArray(parsedNodes)) throw new Error("--nodes must be a JSON array.");
  await hostAction(workspaceRoot, options, async (client) => await client.graphCreate({ graphId: options.graphId, nodes: parsedNodes as GraphNodeInput[], payload: parseJsonOption(options.payload) }));
}

export async function graphListCommand(workspaceRoot: string, options: JsonOption = {}): Promise<void> {
  await graphReadAction(workspaceRoot, options, (graphs) => graphs?.listGraphs() ?? []);
}

export async function graphActionCommand(workspaceRoot: string, action: "start" | "pause" | "resume" | "cancel" | "inspect" | "events", graphId: string, options: JsonOption & { cursor?: number; limit?: number } = {}): Promise<void> {
  if (action === "inspect" || action === "events") {
    await graphReadAction(workspaceRoot, options, (graphs) => {
      if (action === "events") return graphs?.listGraphEvents(graphId, { afterSequence: options.cursor, limit: options.limit })
        ?? { events: [], hasMore: false, gap: false };
      if (!graphs) throw new Error(`Graph ${graphId} does not exist.`);
      return graphs.inspectGraph(graphId);
    });
    return;
  }
  await hostAction(workspaceRoot, options, async (client) => {
    if (action === "start") return await client.graphStart(graphId);
    if (action === "pause") return await client.graphPause(graphId);
    if (action === "resume") return await client.graphResume(graphId);
    return await client.graphCancel(graphId);
  });
}

/** Match desktop persisted projections: absent stores stay absent; schema upgrades need explicit startup. */
async function graphReadAction(workspaceRoot: string, options: JsonOption, read: (graphs: GoalGraphStore | undefined) => unknown): Promise<void> {
  const authority = await RuntimeEventAuthority.openReadOnly(workspaceRoot);
  try {
    const graphs = authority === undefined ? undefined : await GoalGraphStore.open(workspaceRoot, authority);
    const value = read(graphs);
    console.log(options.json ? JSON.stringify(value) : formatPlain(value));
  } finally { authority?.close(); }
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
