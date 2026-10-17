/**
 * Tool transcript projection.
 *
 * Runtime tool events stay unchanged. This module converts their structured
 * input/result into a semantic transcript title and compact output metadata.
 */
import { toolDisplayName, toolPresentation } from "../tools/presentation.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { ToolTranscriptItem, ToolTranscriptStatus } from "./types.js";
import { formatToolResultSummary } from "./toolDiffSummary.js";

const activeOutputLimit = 128 * 1024;

export interface RunningToolItemOptions {
  id: string;
  toolCallId?: string;
  tool: string;
  args: unknown;
  description?: string;
  display?: ToolInputDisplay;
  startedAtMs?: number;
}

export function createRunningToolItem(options: RunningToolItemOptions): ToolTranscriptItem {
  const argsSummary = summarizeToolArgs(options.tool, options.args);
  const item: ToolTranscriptItem = {
    id: options.id,
    kind: "tool",
    toolCallId: options.toolCallId,
    tool: options.tool,
    description: options.description,
    title: semanticToolTitle(options.tool, argsSummary, options.display, options.description, true),
    argsSummary,
    display: options.display,
    status: "running",
    startedAtMs: options.startedAtMs
  };
  return { ...item, details: runningToolDetails(item) };
}

export function updateRunningToolItem(item: ToolTranscriptItem, update: ToolUpdate): ToolTranscriptItem {
  const percent = update.percent === undefined ? "" : `${String(update.percent)}% `;
  const text = update.text ?? update.kind;
  if ((update.kind === "stdout" || update.kind === "stderr") && update.text) {
    const output = `${item.output ?? ""}${update.text}`;
    const next = {
      ...item,
      output: output.length <= activeOutputLimit ? output : output.slice(-activeOutputLimit),
      progress: `${percent}${update.kind}`
    };
    return { ...next, details: runningToolDetails(next) };
  }
  const command = item.display?.kind === "command"
    ? item.display.command
    : item.tool === "Bash"
      ? item.argsSummary
      : undefined;
  if (command && (update.kind === "status" || Boolean(update.text?.includes(command)))) {
    // Shell status updates include the raw command and exit code. Both belong
    // in folded details, never in the active cell's primary output.
    return { ...item, progress: `${percent}Running…` };
  }
  return { ...item, progress: `${percent}${text}`.slice(0, 240) };
}

export function completeToolItem(
  item: ToolTranscriptItem,
  result: unknown,
  forcedStatus?: ToolTranscriptStatus,
  completedAtMs = Date.now()
): ToolTranscriptItem {
  const status = forcedStatus ?? toolStatusFromResult(result);
  const title = status === "skipped"
    ? skippedToolTitle(item)
    : status === "cancelled"
      ? cancelledToolTitle(item)
      : status === "unknown"
        ? unknownToolTitle(item)
    : semanticToolTitle(item.tool, item.argsSummary, item.display, item.description, false);
  const projection = projectToolResult({ ...item, title }, result, status);
  return {
    ...item,
    title,
    status,
    startedAtMs: undefined,
    progress: undefined,
    output: projection.output,
    details: item.fileChange
      ? `${item.fileChange.server ? `Remote (${item.fileChange.server})` : "Committed"} ${item.fileChange.operation}: ${item.fileChange.path}${item.fileChange.destinationPath ? ` → ${item.fileChange.destinationPath}` : ""}\n${projection.details ?? ""}`
      : projection.details,
    durationMs: projection.durationMs ?? elapsedDuration(item.startedAtMs, completedAtMs),
    outputLines: projection.outputLines,
    exitCode: projection.exitCode,
    truncated: projection.truncated,
    operationId: resultField(result, "operationId") ?? item.operationId,
    recovered: resultFieldBoolean(result, "recovered"),
    evidence: resultField(result, "evidence")
  };
}

export function toolStatusFromResult(result: unknown): ToolTranscriptStatus {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (record.executionStatus === "unknown") return "unknown";
    if (record.executionStatus === "cancelled") return record.status === "skipped" ? "skipped" : "cancelled";
    if (record.executionStatus === "succeeded" || record.status === "recovered-success") return "success";
    if (record.status === "denied") return "denied";
    if (record.status === "cancelled") return "cancelled";
    if (record.status === "failed" || record.status === "timed_out" || record.status === "aborted") return "failed";
    if (typeof record.exitCode === "number" && record.exitCode !== 0) return "failed";
    if ("error" in record) return "failed";
  }
  return "success";
}

export function summarizeToolArgs(tool: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : undefined;
  const query = typeof record.query === "string" ? record.query : undefined;
  const command = typeof record.command === "string" ? record.command : undefined;

  if ((tool === "Read" || tool === "Write" || tool === "Edit") && path) return path;
  if (tool === "Grep" && query) return query;
  if (tool === "WebSearch" && query) return query;
  if (tool === "Glob") return "workspace files";
  if (tool === "Bash" && command) return command;
  if ((tool === "BashOutput" || tool === "KillShell") && typeof record.processId === "string") return record.processId;
  return summarizeValue(args, 800);
}

export function semanticToolTitle(
  tool: string,
  argsSummary: string,
  display: ToolInputDisplay | undefined,
  description: string | undefined,
  running: boolean
): string {
  if (tool === "Bash" || display?.kind === "command") {
    const command = display?.kind === "command" ? display.command : argsSummary;
    return semanticCommandTitle(command, running);
  }
  if (tool === "Read") return `${running ? "Reading" : "Read"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "Write") return `${running ? "Writing" : "Wrote"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "Edit") return `${running ? "Editing" : "Edited"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "Glob") return running ? "Listing workspace files" : "Listed workspace files";
  if (tool === "Grep") {
    return `${running ? "Searching" : "Searched"}${argsSummary ? ` for “${argsSummary}”` : " workspace"}`;
  }
  if (tool === "WebSearch") {
    return `${running ? "Searching the web" : "Searched the web"}${argsSummary ? ` for “${argsSummary}”` : ""}`;
  }
  if (tool === "BashOutput") return `${running ? "Reading" : "Read"} background process${argsSummary ? ` ${argsSummary}` : "es"}`;
  if (tool === "KillShell") return `${running ? "Stopping" : "Stopped"} background process${argsSummary ? ` ${argsSummary}` : ""}`;
  if (toolPresentation(tool)) return `${running ? "正在" : "已"}${toolDisplayName(tool)}`;
  const safeDescription = description?.trim();
  if (safeDescription && safeDescription.length <= 120) return safeDescription;
  return `${running ? "Running" : "Ran"} ${humanizeToolName(tool)}`;
}

interface ToolResultProjection {
  output: string;
  details: string;
  durationMs?: number;
  outputLines?: number;
  exitCode?: number;
  truncated?: boolean;
}

function projectToolResult(item: ToolTranscriptItem, result: unknown, status: ToolTranscriptStatus): ToolResultProjection {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
  const durationMs = typeof record?.durationMs === "number" ? record.durationMs : undefined;
  const outputLines = typeof record?.outputLines === "number" ? record.outputLines : undefined;
  const exitCode = typeof record?.exitCode === "number" ? record.exitCode : undefined;
  const truncated = typeof record?.truncated === "boolean" ? record.truncated : undefined;

  if (item.tool === "WebSearch") return projectWebSearchResult(result, status, durationMs, outputLines, truncated);

  if (item.tool === "Bash" && record?.background === true) {
    const process = typeof record.process === "object" && record.process !== null ? record.process as Record<string, unknown> : {};
    const processId = typeof process.processId === "string" ? process.processId : "unknown";
    const state = typeof process.state === "string" ? process.state : "started";
    return {
      output: `Background process ${processId} ${state}`,
      details: summarizeValue(result, 8_000),
      durationMs,
      outputLines: 1
    };
  }

  if (item.tool === "BashOutput") {
    const process = typeof record?.process === "object" && record.process !== null ? record.process as Record<string, unknown> : undefined;
    const outputRecord = typeof record?.output === "object" && record.output !== null ? record.output as Record<string, unknown> : undefined;
    const content = typeof outputRecord?.content === "string" ? outputRecord.content.trimEnd() : "";
    const state = typeof process?.state === "string" ? process.state : undefined;
    const listed = Array.isArray(record?.processes) ? record.processes.length : undefined;
    const output = content || (listed !== undefined ? `${String(listed)} background processes` : state ? `Process ${state}` : "No process output");
    return {
      output,
      details: summarizeValue(result, 8_000),
      durationMs,
      outputLines: logicalLineCount(output),
      truncated: outputRecord?.hasMore === true || outputRecord?.omittedBefore === true
    };
  }

  if (item.tool === "KillShell") {
    const state = typeof record?.state === "string" ? record.state : "stopped";
    return {
      output: `Background process ${state}`,
      details: summarizeValue(result, 8_000),
      durationMs,
      outputLines: 1
    };
  }

  if (item.tool === "Bash" || item.display?.kind === "command") {
    const command = item.display?.kind === "command" ? item.display.command : item.argsSummary;
    const stdout = typeof record?.stdout === "string" ? record.stdout.trimEnd() : "";
    const error = typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : "";
    const stderr = typeof record?.stderr === "string" ? record.stderr.trimEnd() : error;
    const output = commandOutputPreview(stdout, stderr, status);
    return {
      output,
      details: [
        `Command: ${command || "(unknown)"}`,
        `Exit code: ${exitCode === undefined ? "unknown" : String(exitCode)}`,
        ...(stdout ? ["", "stdout:", stdout] : []),
        ...(stderr ? ["", "stderr:", stderr] : []),
        ...(!stdout && !stderr ? ["", "(no output)"] : [])
      ].join("\n"),
      durationMs,
      outputLines: outputLines ?? logicalLineCount([stdout, stderr].filter(Boolean).join("\n")),
      exitCode,
      truncated
    };
  }

  const formatted = formatToolResultSummary(item.tool, result);
  const rawOutput = extractOutput(result);
  const output = removeDuplicateTitle(formatted ?? rawOutput ?? summarizeValue(result, 64 * 1024), item.title)
    || (status === "success" ? "Completed" : status === "denied" ? "Denied" : status === "skipped" ? "Skipped" : status === "cancelled" ? "Cancelled" : status === "unknown" ? "Completion status unknown" : "Failed");
  return {
    output,
    details: [
      item.argsSummary ? `Input: ${item.argsSummary}` : "",
      rawOutput ?? summarizeValue(result, 256 * 1024)
    ].filter(Boolean).join("\n\n"),
    durationMs,
    outputLines: outputLines ?? logicalLineCount(output),
    exitCode,
    truncated
  };
}

function projectWebSearchResult(
  result: unknown,
  status: ToolTranscriptStatus,
  durationMs: number | undefined,
  outputLines: number | undefined,
  truncated: boolean | undefined
): ToolResultProjection {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
  const error = typeof record?.error === "string"
    ? record.error
    : typeof record?.message === "string"
      ? record.message
      : undefined;
  if (status !== "success" || error) {
    const output = error ?? (status === "denied" ? "Denied" : "Web search failed");
    return { output, details: output, durationMs, outputLines: 1, truncated };
  }

  const query = typeof record?.query === "string" ? record.query : "(unknown)";
  const provider = typeof record?.provider === "string" ? record.provider : "web";
  const rawResults = Array.isArray(record?.results) ? record.results : [];
  const resultLines: string[] = [];
  for (const [index, rawResult] of rawResults.entries()) {
    if (typeof rawResult !== "object" || rawResult === null) continue;
    const item = rawResult as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const snippet = typeof item.snippet === "string" ? item.snippet : "";
    if (!title || !url) continue;
    resultLines.push(`${index + 1}. ${title}`, `   ${url}`, ...(snippet ? [`   ${snippet}`] : []), "");
  }

  const output = resultLines.length > 0 ? resultLines.join("\n").trimEnd() : "No search results.";
  const details = [
    `Query: ${query}`,
    `Provider: ${provider}`,
    `Results: ${String(rawResults.length)}`,
    "",
    output
  ].join("\n");
  return {
    output,
    details,
    durationMs,
    outputLines: outputLines ?? logicalLineCount(output),
    truncated
  };
}

function commandOutputPreview(stdout: string, stderr: string, status: ToolTranscriptStatus): string {
  if (status === "failed" || status === "denied" || status === "unknown" || status === "cancelled") {
    return stderr || stdout || (status === "denied" ? "Denied" : status === "unknown" ? "Completion status unknown" : status === "cancelled" ? "Cancelled" : "Command failed");
  }
  if (stdout && stderr) return `${stdout}\nstderr:\n${stderr}`;
  return stdout || stderr || "Command completed";
}

function runningToolDetails(item: ToolTranscriptItem): string {
  if (item.tool === "Bash" || item.display?.kind === "command") {
    const command = item.display?.kind === "command" ? item.display.command : item.argsSummary;
    return [
      `Command: ${command || "(unknown)"}`,
      "Exit code: running",
      item.output ? `\noutput (live):\n${item.output}` : "\n(no output yet)"
    ].join("\n");
  }
  return item.argsSummary ? `Input: ${item.argsSummary}` : "Working…";
}

function skippedToolTitle(item: ToolTranscriptItem): string {
  const title = item.title.replace(
    /^(?:Reading|Writing|Editing|Running|Checking|Listing|Searching|Building|Installing)\s*/u,
    "Skipped "
  ).trimEnd();
  return title === item.title ? `Skipped ${humanizeToolName(item.tool)}` : title;
}

function cancelledToolTitle(item: ToolTranscriptItem): string {
  const title = item.title.replace(
    /^(?:Reading|Writing|Editing|Running|Checking|Listing|Searching|Building|Installing)\s*/u,
    "Cancelled "
  ).trimEnd();
  return title === item.title ? `Cancelled ${humanizeToolName(item.tool)}` : title;
}

function unknownToolTitle(item: ToolTranscriptItem): string {
  const title = item.title.replace(
    /^(?:Reading|Writing|Editing|Running|Checking|Listing|Searching|Building|Installing)\s*/u,
    "Status unknown for "
  ).trimEnd();
  return title === item.title ? `Status unknown for ${humanizeToolName(item.tool)}` : title;
}

function semanticCommandTitle(command: string, running: boolean): string {
  const normalized = command.trim().toLowerCase();
  const pair = (active: string, complete: string): string => running ? active : complete;
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|go test|cargo test)\b/.test(normalized)) {
    return pair("Running tests", "Ran tests");
  }
  if (/\btypecheck\b|\btsc\b[^\n]*(?:--noemit|-p\b)/.test(normalized)) return pair("Checking types", "Checked types");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|go)\s+build\b/.test(normalized)) {
    return pair("Building project", "Built project");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:install|add)\b/.test(normalized)) return pair("Installing dependencies", "Installed dependencies");
  if (/^(?:git\s+)?status\b|\bgit\s+status\b/.test(normalized)) return pair("Checking git status", "Checked git status");
  if (/\bgit\s+diff\b/.test(normalized)) return pair("Reading git diff", "Viewed git diff");
  if (/^(?:rg|grep)\b|\s(?:rg|grep)\s/.test(normalized)) return pair("Searching workspace", "Searched workspace");
  if (/^(?:ls|find)\b/.test(normalized)) return pair("Listing files", "Listed files");
  if (/^(?:cat|sed|head|tail)\b/.test(normalized)) return pair("Reading files", "Read files");
  return pair("Running command", "Ran command");
}

function removeDuplicateTitle(value: string, title: string): string {
  const [first = "", ...rest] = value.split("\n");
  if (first.trim() === title.trim() || title.endsWith(first.trim())) return rest.join("\n").trim();
  return value.trim();
}

function extractOutput(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return typeof result === "string" ? result : undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output.trimEnd();
  if (typeof record.content === "string") return record.content.trimEnd();
  if (typeof record.error === "string") return record.error;
  return undefined;
}

function summarizeValue(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    return JSON.stringify(value, null, 2).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function logicalLineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function elapsedDuration(startedAtMs: number | undefined, completedAtMs: number): number | undefined {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) return undefined;
  return Math.max(0, completedAtMs - startedAtMs);
}

function humanizeToolName(tool: string): string {
  return toolDisplayName(tool);
}

function resultField(result: unknown, key: string): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function resultFieldBoolean(result: unknown, key: string): boolean | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}
