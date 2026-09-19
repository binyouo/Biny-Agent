#!/usr/bin/env node
/**
 * Biny 的命令行入口模块。
 *
 * 这里集中声明 `init`、`run`、`chat`、`tui` 等子命令，并把执行逻辑转交给
 * `commands/` 下的具体实现。入口层只处理参数拼接、默认 TUI 和异常展示，
 * 不直接承载 agent、工具或 TUI 的业务流程。
 */
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { initCommand } from "./commands/init.js";
import { registerCrystalCommands } from "./commands/crystal.js";
import { registerFatigueCommands } from "./commands/fatigue.js";
import { registerSoulCommands } from "./commands/soul.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand, type RunCommandOptions } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";
import { evalCompareCommand, evalRunCommand } from "./commands/evals.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionsCommand, type SessionsCommandOptions } from "./commands/sessions.js";
import { sessionExportCommand, sessionImportCommand } from "./commands/sessionTransfer.js";
import type { SessionTransferFormat } from "../session/transfer.js";
import { tuiCommand } from "./commands/tui.js";
import { registerSkillCommands } from "./commands/skills.js";
import { runtimeHostCommand } from "./commands/runtimeHost.js";
import { emotionGetCommand, emotionSetBaseCommand, emotionSetContextCommand, emotionStatusCommand } from "./commands/emotion.js";
import {
  activityClearCommand,
  activityConfigCommand,
  activityConfigSetCommand,
  activityDigestCommand,
  activityReportCommand,
  activityAnalyzeCommand,
  activityRecordingCommand,
  activitySearchCommand,
  activityServeCommand,
  activitySessionsCommand,
  activityShowCommand,
  activityStatusCommand,
  activitySuggestionsCommand,
  activitySummaryCommand
} from "./commands/activity.js";
import {
  automationCreateCommand,
  automationDeleteCommand,
  automationListCommand,
  automationPendingCommand,
  automationPauseCommand,
  automationResumeCommand,
  automationRunCommand,
  daemonInstallCommand,
  daemonRunCommand,
  daemonStatusCommand,
  daemonUninstallCommand,
  goalActionCommand,
  goalCreateCommand,
  goalListCommand,
  graphActionCommand,
  graphCreateCommand,
  graphListCommand,
  taskActionCommand,
  taskCreateCommand,
  taskEventsCommand,
  taskGetCommand,
  taskListCommand
} from "./commands/runtimeManagement.js";
import {
  diaryRefreshCommand,
  diaryShowCommand,
  heartbeatRunCommand,
  heartbeatShowCommand,
  heartbeatStatusCommand,
  memoryAddCommand,
  memoryArchiveCommand,
  memoryClearCommand,
  memoryListCommand,
  memorySearchCommand,
  memoryStatsCommand,
  memorySleepCommand,
  historySearchCommand,
  reflectionRunCommand,
  reflectionStatusCommand,
  todoClearCommand,
  todoReplaceCommand,
  todoShowCommand
} from "./commands/localCapabilities.js";

const program = new Command();
// CLI 的工作区以用户执行 biny 时的当前目录为准。
const workspaceRoot = process.cwd();
// `pnpm dev -- <command>` 会把分隔符保留在 tsx 脚本的 argv 中；去掉它，保证开发入口和已安装的 biny 解析一致。
const cliArgv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;
// 版本号来自 package.json，界面头部和 `--version` 用同一个来源。
const { version: cliVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

program.name("biny").description("Biny local desktop assistant").version(cliVersion);
registerCrystalCommands(program);
registerSoulCommands(program);
registerFatigueCommands(program);
registerSkillCommands(program, workspaceRoot);

program.command("init").description("Initialize config and .biny directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program
  .command("chat")
  .description("Start a new interactive chat")
  .action(() => wrap(() => chatCommand(workspaceRoot, cliVersion))());
program.command("tui").description("Start terminal UI mode").action(wrap(() => tuiCommand(workspaceRoot, cliVersion)));
program
  .command("runtime-host")
  .description("Run the shared Runtime Host process")
  .option("--workspace-root <path>", "workspace root")
  .option("--persistence-root <path>", "session and runtime persistence root")
  .option("--config-dir <path>", "global config directory")
  .option("--attachment-root <path>", "attachment directory")
  .option("--session-id <id>", "session to resume")
  .option("--resume-interrupted", "resume the latest interrupted turn")
  .allowUnknownOption()
  .action(() => wrap(runtimeHostCommand)());
const daemon = program.command("daemon").description("Manage the local resident Runtime Host");
daemon.command("install").description("Install and load a user LaunchAgent").action(wrap(() => daemonInstallCommand(workspaceRoot)));
daemon.command("uninstall").description("Unload and remove the user LaunchAgent").action(wrap(() => daemonUninstallCommand(workspaceRoot)));
daemon.command("status").description("Show LaunchAgent and Runtime Host status").action(wrap(() => daemonStatusCommand(workspaceRoot)));
daemon.command("run").description("Run the Runtime Host in the foreground").action(wrap(() => daemonRunCommand(workspaceRoot)));

const automation = program.command("automation").description("Manage durable local automations");
automation.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => automationListCommand(workspaceRoot, options))());
automation.command("pending").argument("[automationId]", "filter by automation id").option("--json", "print JSON").action((automationId: string | undefined, options: { json?: boolean }) => wrap(() => automationPendingCommand(workspaceRoot, automationId, options))());
automation
  .command("create")
  .argument("<name>", "automation name")
  .requiredOption("--prompt <text>", "prompt to execute")
  .requiredOption("--trigger <type>", "heartbeat, cron, interval, or once")
  .option("--cron <expression>", "five-field cron expression")
  .option("--interval-ms <milliseconds>", "interval in milliseconds", parsePositiveInteger)
  .option("--at <timestamp>", "ISO timestamp for once")
  .option("--jitter-ms <milliseconds>", "maximum schedule jitter", parseNonNegativeInteger)
  .option("--session <id>", "heartbeat target session")
  .option("--max-fires <count>", "maximum fire count", parsePositiveInteger)
  .option("--expires-at <timestamp>", "ISO expiry timestamp")
  .option("--json", "print JSON")
  .action((name: string, options: { prompt: string; trigger: string; cron?: string; intervalMs?: number; at?: string; jitterMs?: number; session?: string; maxFires?: number; expiresAt?: string; json?: boolean }) => wrap(() => automationCreateCommand(workspaceRoot, {
    name,
    triggerType: options.trigger as "heartbeat" | "cron" | "interval" | "once",
    schedule: { cron: options.cron, intervalMs: options.intervalMs, at: options.at, jitterMs: options.jitterMs },
    executionTemplate: { prompt: options.prompt, sessionId: options.session },
    maxFires: options.maxFires,
    expiresAt: options.expiresAt
  }, options))());
for (const [name, action] of [["pause", automationPauseCommand], ["resume", automationResumeCommand], ["run", automationRunCommand], ["delete", automationDeleteCommand]] as const) {
  automation.command(name).argument("<automationId>", "automation id").option("--json", "print JSON").action((automationId: string, options: { json?: boolean }) => wrap(() => action(workspaceRoot, automationId, options))());
}

const task = program.command("task").description("Manage durable TaskRuns");
task
  .command("create")
  .argument("<task...>", "task text")
  .option("--session <id>", "session id")
  .option("--parent-run <id>", "parent AgentRun id")
  .option("--verification <json>", "deterministic verification contract JSON")
  .option("--json", "print JSON")
  .action((input: string[], options: { session?: string; parentRun?: string; verification?: string; json?: boolean }) => wrap(() => taskCreateCommand(workspaceRoot, input.join(" "), { json: options.json, sessionId: options.session, parentRunId: options.parentRun, verification: options.verification }))());
for (const [name, action] of [["start", "start"], ["cancel", "cancel"], ["approve", "approve"], ["resume", "resume"], ["retry", "retry"]] as const) {
  task
    .command(name)
    .argument("<taskRunId>", "TaskRun id")
    .option("--reason <text>", "cancellation reason")
    .option("--retry-safety <safety>", "safe, idempotent, unsafe, or unknown")
    .option("--approval-id <id>", "exact approval id shown by the current needs_approval result")
    .option("--json", "print JSON")
    .action((taskRunId: string, options: { reason?: string; retrySafety?: string; approvalId?: string; json?: boolean }) => wrap(() => taskActionCommand(workspaceRoot, action, taskRunId, options))());
}
task.command("run").argument("<taskRunId>", "TaskRun id").option("--retry-safety <safety>", "safe, idempotent, unsafe, or unknown").option("--json", "print JSON").action((taskRunId: string, options: { retrySafety?: string; json?: boolean }) => wrap(() => taskActionCommand(workspaceRoot, "run", taskRunId, options))());
task.command("get").argument("<taskRunId>", "TaskRun id").option("--json", "print JSON").action((taskRunId: string, options: { json?: boolean }) => wrap(() => taskGetCommand(workspaceRoot, taskRunId, options))());
task.command("list").option("--status <status>", "TaskRun status").option("--limit <count>", "maximum rows", parsePositiveInteger).option("--json", "print JSON").action((options: { status?: string; limit?: number; json?: boolean }) => wrap(() => taskListCommand(workspaceRoot, options))());
task.command("events").argument("<taskRunId>", "TaskRun id").option("--limit <count>", "maximum events", parsePositiveInteger).option("--json", "print JSON").action((taskRunId: string, options: { limit?: number; json?: boolean }) => wrap(() => taskEventsCommand(workspaceRoot, taskRunId, options))());

const memory = program.command("memory").description("Manage local memory");
memory.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => memoryListCommand(workspaceRoot, options))());
memory.command("stats").description("Show memory store counts and maintenance status").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => memoryStatsCommand(workspaceRoot, options))());
memory.command("search").argument("<query...>", "search query").option("--tag <tag...>", "filter entries carrying all given tags").option("--json", "print JSON").action((query: string[], options: { tag?: string[]; json?: boolean }) => wrap(() => memorySearchCommand(workspaceRoot, query.join(" "), options))());
memory.command("add").requiredOption("--entry <json>", "structured memory JSON").option("--json", "print JSON").action((options: { entry: string; json?: boolean }) => wrap(() => memoryAddCommand(workspaceRoot, options.entry, options))());
memory.command("archive").argument("<id>", "memory id").requiredOption("--yes", "confirm archive").option("--json", "print JSON").action((id: string, options: { yes?: boolean; json?: boolean }) => wrap(() => memoryArchiveCommand(workspaceRoot, id, options))());
memory.command("clear").requiredOption("--yes", "confirm clear").option("--json", "print JSON").action((options: { yes?: boolean; json?: boolean }) => wrap(() => memoryClearCommand(workspaceRoot, options))());
const history = program.command("history").description("Search past conversation transcripts");
history.command("search").argument("<query...>", "full-text query over past user and assistant messages").option("--limit <n>", "maximum hits", "8").option("--json", "print JSON").action((query: string[], options: { limit: string; json?: boolean }) => wrap(() => historySearchCommand(query.join(" "), { limit: Number(options.limit), json: options.json }))());

memory.command("sleep").option("--run", "run maintenance now").option("--yes", "confirm maintenance").option("--json", "print JSON").action((options: { run?: boolean; yes?: boolean; json?: boolean }) => wrap(() => memorySleepCommand(workspaceRoot, options))());

const diary = program.command("diary").description("Show or refresh daily notes");
diary.command("show").argument("[date]", "today, yesterday, or YYYY-MM-DD", "today").option("--json", "print JSON").action((date: string, options: { json?: boolean }) => wrap(() => diaryShowCommand(workspaceRoot, date, options))());
diary.command("refresh").argument("[date]", "today, yesterday, or YYYY-MM-DD", "today").option("--force", "refresh even when markers exist").option("--json", "print JSON").action((date: string, options: { force?: boolean; json?: boolean }) => wrap(() => diaryRefreshCommand(workspaceRoot, date, options))());

const reflection = program.command("reflection").description("Run or inspect daily self-reflection");
reflection.command("status").argument("[date]", "today, yesterday, or YYYY-MM-DD", "today").option("--json", "print JSON").action((date: string, options: { json?: boolean }) => wrap(() => reflectionStatusCommand(workspaceRoot, date, options))());
reflection.command("run").argument("[date]", "today, yesterday, or YYYY-MM-DD", "today").option("--force", "refresh even when markers exist").option("--json", "print JSON").action((date: string, options: { force?: boolean; json?: boolean }) => wrap(() => reflectionRunCommand(workspaceRoot, date, options))());

const heartbeat = program.command("heartbeat").description("Inspect or trigger Heartbeat");
heartbeat.command("status").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => heartbeatStatusCommand(workspaceRoot, options))());
heartbeat.command("run").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => heartbeatRunCommand(workspaceRoot, options))());
heartbeat.command("show").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => heartbeatShowCommand(workspaceRoot, options))());

const todo = program.command("todo").description("Manage the current session Todo list");
todo.command("show").option("--session <id>", "session id; defaults to latest").option("--json", "print JSON").action((options: { session?: string; json?: boolean }) => wrap(() => todoShowCommand(workspaceRoot, options.session, options))());
todo.command("replace").requiredOption("--todos <json>", "complete Todo list JSON").option("--session <id>", "session id; defaults to latest").option("--json", "print JSON").action((options: { todos: string; session?: string; json?: boolean }) => wrap(() => todoReplaceCommand(workspaceRoot, options.session, options.todos, options))());
todo.command("clear").requiredOption("--yes", "confirm clear").option("--session <id>", "session id; defaults to latest").option("--json", "print JSON").action((options: { yes?: boolean; session?: string; json?: boolean }) => wrap(() => todoClearCommand(workspaceRoot, options.session, options))());

const goal = program.command("goal").description("Manage durable goals");
goal.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => goalListCommand(workspaceRoot, options))());
goal.command("create").argument("<title>", "goal title").option("--payload <json>", "JSON payload").option("--goal-id <id>", "explicit goal id").option("--json", "print JSON").action((title: string, options: { payload?: string; goalId?: string; json?: boolean }) => wrap(() => goalCreateCommand(workspaceRoot, title, options))());
for (const [name, action] of [["get", "get"], ["pause", "pause"], ["resume", "resume"], ["cancel", "cancel"]] as const) {
  goal.command(name).argument("<goalId>", "goal id").option("--json", "print JSON").action((goalId: string, options: { json?: boolean }) => wrap(() => goalActionCommand(workspaceRoot, action, goalId, options))());
}

const graph = program.command("graph").description("Manage durable Agent Graphs");
graph.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => graphListCommand(workspaceRoot, options))());
graph.command("create").requiredOption("--nodes <json>", "JSON node array").option("--goal-id <id>", "goal id").option("--graph-id <id>", "explicit graph id").option("--payload <json>", "JSON payload").option("--json", "print JSON").action((options: { nodes: string; goalId?: string; graphId?: string; payload?: string; json?: boolean }) => wrap(() => graphCreateCommand(workspaceRoot, options))());
for (const [name, action] of [["start", "start"], ["pause", "pause"], ["resume", "resume"], ["cancel", "cancel"], ["inspect", "inspect"], ["events", "events"]] as const) {
  graph.command(name).argument("<graphId>", "graph id").option("--json", "print JSON").action((graphId: string, options: { json?: boolean }) => wrap(() => graphActionCommand(workspaceRoot, action, graphId, options))());
}
program
  .command("sessions")
  .description("List recorded sessions")
  .option("--limit <count>", "maximum sessions in one page", parsePositiveInteger)
  .option("--cursor <cursor>", "continue from a previous page")
  .option("--parent <session-id>", "only list direct children of a session")
  .option("--json", "print the page as JSON")
  .action((options: SessionsCommandOptions) => wrap(() => sessionsCommand(workspaceRoot, options))());
const session = program.command("session").description("Export and import sessions");
session
  .command("export")
  .description("Export a session to a Biny bundle (.json) or Claude Code (.jsonl) file")
  .argument("<session>", "session id or .jsonl path")
  .option("--format <format>", "biny (default) or claude", "biny")
  .option("--out <path>", "output file path; defaults to ./<sessionId>.<ext>")
  .option("--json", "print the result as JSON")
  .action((sessionRef: string, options: { format?: string; out?: string; json?: boolean }) => {
    const format = options.format === "claude" ? "claude" : "biny";
    return wrap(() => sessionExportCommand(workspaceRoot, sessionRef, { format, out: options.out, json: options.json }))();
  });
session
  .command("import")
  .description("Import a Biny, Claude Code, or Codex session file as a new session")
  .argument("<file>", "path to the session file to import")
  .option("--format <format>", "source format: biny, claude, or codex (auto-detected by default)")
  .option("--json", "print the result as JSON")
  .action((file: string, options: { format?: string; json?: boolean }) => {
    const format: SessionTransferFormat | undefined = options.format === "biny" || options.format === "claude" || options.format === "codex" ? options.format : undefined;
    return wrap(() => sessionImportCommand(workspaceRoot, file, { format, json: options.json }))();
  });
const activity = program.command("activity").description("Inspect and serve local Activity Recorder data");
activity.command("analyze").argument("<session-id>", "activity session to analyze again").option("--json", "print JSON").action((sessionId: string, options: { json?: boolean }) => wrap(() => activityAnalyzeCommand(workspaceRoot, sessionId, options))());
activity.command("status").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => activityStatusCommand(workspaceRoot, options))());
for (const [name, enabled] of [["start", true], ["stop", false]] as const) {
  activity.command(name).description(enabled ? "Enable recording via the shared config" : "Pause recording via the shared config").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => activityRecordingCommand(workspaceRoot, enabled, options))());
}
activity.command("show").argument("<session-id>", "activity session to inspect").option("--json", "print JSON").action((sessionId: string, options: { json?: boolean }) => wrap(() => activityShowCommand(workspaceRoot, sessionId, options))());
const activityConfig = activity.command("config").description("Print the recorder config");
activityConfig.option("--json", "print JSON").action((options: { json?: boolean }) => wrap(() => activityConfigCommand(workspaceRoot, options))());
activityConfig
  .command("set")
  .argument("<key>", "ActivitySettings key, e.g. jpegQuality")
  .argument("<value>", "JSON value or raw string")
  .option("--json", "print JSON")
  .action((key: string, value: string, options: { json?: boolean }) => wrap(() => activityConfigSetCommand(workspaceRoot, key, value, options))());
activity
  .command("search")
  .argument("<query...>", "keyword query")
  .option("--semantic", "use local embedding semantic search instead of keyword FTS")
  .option("--limit <count>", "maximum results", parsePositiveInteger)
  .option("--json", "print JSON")
  .action((query: string[], options: { semantic?: boolean; limit?: number; json?: boolean }) => wrap(() => activitySearchCommand(workspaceRoot, query.join(" "), options))());
activity
  .command("sessions")
  .option("--limit <count>", "maximum sessions", parsePositiveInteger)
  .option("--since <timestamp>", "ISO lower bound")
  .option("--json", "print JSON")
  .action((options: { limit?: number; since?: string; json?: boolean }) => wrap(() => activitySessionsCommand(workspaceRoot, options))());
activity
  .command("digest")
  .option("--lookback-min <minutes>", "minutes to include", parsePositiveInteger)
  .option("--json", "print JSON")
  .action((options: { lookbackMin?: number; json?: boolean }) => wrap(() => activityDigestCommand(workspaceRoot, options))());
activity
  .command("report")
  .argument("[date]", "today, yesterday, or YYYY-MM-DD", "today")
  .option("--json", "print JSON")
  .action((date: string, options: { json?: boolean }) => wrap(() => activityReportCommand(workspaceRoot, date, options))());
activity
  .command("summary")
  .argument("<kind>", "daily or weekly")
  .argument("[date]", "YYYY-MM-DD; weekly 的 date 代表该周周一", localDateKey())
  .option("--json", "print JSON")
  .action((kind: string, date: string, options: { json?: boolean }) => {
    if (kind !== "daily" && kind !== "weekly") throw new Error("summary kind 只支持 daily 或 weekly。");
    return wrap(() => activitySummaryCommand(workspaceRoot, kind, date, options))();
  });
activity
  .command("suggestions")
  .option("--force", "ignore the ten-minute cache")
  .option("--json", "print JSON")
  .action((options: { force?: boolean; json?: boolean }) => wrap(() => activitySuggestionsCommand(workspaceRoot, options))());
activity
  .command("clear")
  .requiredOption("--yes", "confirm deletion of local Activity data")
  .option("--json", "print JSON")
  .action((options: { yes?: boolean; json?: boolean }) => wrap(() => activityClearCommand(workspaceRoot, options))());
activity
  .command("serve")
  .description("Run the loopback Activity REST API and recorder")
  .option("--port <port>", "TCP port; 0 chooses a free port", parseNonNegativeInteger, 0)
  .action((options: { port?: number }) => wrap(() => activityServeCommand(workspaceRoot, options))());
const emotion = program.command("emotion").description("Read and update local emotion snapshots");
emotion.action(wrap(() => emotionStatusCommand()));
emotion.command("status").description("Show current emotion state").action(wrap(() => emotionStatusCommand()));
emotion
  .command("set-base")
  .argument("<mood>", "base mood")
  .argument("<energy>", "energy from 0 to 10")
  .argument("<valence>", "valence from 0 to 10")
  .argument("[description...]", "reason")
  .action((mood: string, energy: string, valence: string, description: string[]) => wrap(() => emotionSetBaseCommand(mood, energy, valence, description))());
emotion
  .command("set-context")
  .argument("<sessionId>", "session or chat id")
  .argument("<mood>", "context mood")
  .argument("<valence>", "valence from 0 to 10")
  .argument("[trigger...]", "reason")
  .action((sessionId: string, mood: string, valence: string, trigger: string[]) => wrap(() => emotionSetContextCommand(sessionId, mood, valence, trigger))());
emotion
  .command("get")
  .argument("[sessionId]", "session or chat id")
  .action((sessionId?: string) => wrap(() => emotionGetCommand(sessionId))());
program
  .command("run")
  .description("Run a one-shot agent task")
  .option("--model <alias>", "override the configured model alias for this run")
  .option("--max-steps <steps>", "override the hard step limit", parsePositiveInteger)
  .option("--soft-steps <steps>", "override the soft step limit", parsePositiveInteger)
  .option("--permission-mode <mode>", "override permission mode: ask, read-only, auto, full-access")
  .option("--headless", "run without interactive permission prompts")
  .option("--isolated", "run in a dedicated git worktree session")
  .option("--json", "print one machine-readable JSON result")
  .argument("<input...>", "task text")
  .action((input: string[], options: RunCommandOptions) => wrap(async () => { await runCommand(workspaceRoot, input.join(" "), options); })());
const evals = program.command("eval").description("Run and compare agent evaluations");
evals
  .command("run")
  .description("Run the built-in eval suite and write a report")
  .option("--label <label>", "label for this run, used in the report and comparisons")
  .option("--out <path>", "where to write the JSON report")
  .option("--task <id...>", "only run these task ids")
  .action((options: { label?: string; out?: string; task?: string[] }) => wrap(() => evalRunCommand(workspaceRoot, {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.out === undefined ? {} : { out: options.out }),
    ...(options.task === undefined ? {} : { tasks: options.task })
  }))());
evals
  .command("compare")
  .description("Compare two eval reports")
  .argument("<baseline>", "baseline report path")
  .argument("<candidate>", "candidate report path")
  .action((baseline: string, candidate: string) => wrap(() => evalCompareCommand(baseline, candidate))());

program
  .command("resume")
  .description("Resume an existing session in the TUI")
  .argument("[session]", "session id or .jsonl path; omit to choose from the session picker")
  .action((session: string | undefined) => wrap(() => resumeCommand(workspaceRoot, cliVersion, session))());


if (cliArgv.length <= 2) {
  await wrap(() => tuiCommand(workspaceRoot, cliVersion))();
} else {
  await program.parseAsync(cliArgv);
}

function wrap(fn: () => Promise<void>): () => Promise<void> {
  // 所有命令都经过 wrap，保证异步异常不会打印冗长堆栈到普通用户界面。
  return async () => {
    try {
      await fn();
    } catch (error) {
      // CLI 层只负责把错误展示给用户，详细事件记录由 runtime / agent 层处理。
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

// commander 只接管 InvalidArgumentError（打印单行错误后退出）；普通 Error 会穿透
// parseAsync 变成未处理异常，把堆栈打到终端，绕过 wrap() 的干净错误展示。
function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got: ${value}`);
  return parsed;
}

function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
}
