/**
 * 工具结果的模型侧投影。
 *
 * 工具结果在 session、实时事件和模型上下文里承担不同职责：session 要保留事实，模型只
 * 需要下一步决策所需的证据。本模块只复制消息并生成投影视图，绝不改写调用方持有的原始
 * 消息；需要丢掉正文时通过注入的归档回调保存完整结果。
 */
import { createHash } from "node:crypto";
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentToolCallContent,
  AgentToolResultMessage
} from "./core/types.js";
import { serializeToolResult } from "../session/toolResultArchive.js";

const defaultProjectionThresholdBytes = 8 * 1024;
const defaultKeepRecentResults = 2;
const maxCommandStreamCharacters = 6_000;
const maxReadContentCharacters = 10_000;
const maxSearchMatchCharacters = 600;
const maxSearchOutputBytes = 12 * 1024;
const projectionMarker = "[biny model projection]";
const archivePathPattern = /.biny\/tool-results\/tool-result-[0-9a-f]{64}\.json/u;

type ReplacementReason = "duplicate" | "read_covered" | "snapshot_replaced" | "failure_resolved";

interface ToolCallInfo {
  tool: string;
  args: unknown;
  step: number;
}

interface ToolResultEntry {
  index: number;
  message: AgentToolResultMessage;
  value: unknown;
  serialized: string;
  call?: ToolCallInfo;
  step: number;
  currentTurn: boolean;
}

interface Replacement {
  reason: ReplacementReason;
  archive: boolean;
}

interface ReadRange {
  path: string;
  kind: "full" | "line" | "offset";
  start: number;
  end: number;
}

export interface ToolResultProjectionArchiveRequest {
  message: AgentToolResultMessage;
  result: unknown;
  output: string;
  /** 消息位置是稳定且不依赖模型输入的归档 nonce；文件名仍由归档模块哈希。 */
  sequence: number;
}

export interface ToolResultProjectionArchiveReference {
  archivePath: string;
  resultBytes: number;
}

export interface ToolResultProjectionOptions {
  /** 单结果超过该字节数才进入正文投影；专用的轻量字段清理不受此阈值限制。 */
  thresholdBytes?: number;
  /** 最近结果保留正文，避免模型刚拿到的证据马上被折叠。 */
  keepRecentResults?: number;
  archiveResult?: (
    request: ToolResultProjectionArchiveRequest
  ) => Promise<ToolResultProjectionArchiveReference>;
  /** 单结果调用时用于生成稳定的归档信封；批量消息投影会直接读取消息上的这些值。 */
  toolCallId?: string;
  sequence?: number;
}

/**
 * 在工具结果预算之前生成单个结果的专用模型视图。
 *
 * 这里不做 working-set 语义替代，只处理工具自身可以确定的字段压缩；working-set 去重仍由
 * `projectToolResultsForModel` 在完整消息上下文上完成。
 */
export async function projectSingleToolResultForModel(
  toolName: string,
  args: unknown,
  value: unknown,
  options: ToolResultProjectionOptions = {}
): Promise<unknown> {
  const message: AgentToolResultMessage = {
    role: "toolResult",
    toolCallId: options.toolCallId ?? "projection",
    toolName,
    content: [{ type: "text", text: serializeToolResult(value) }],
    details: value
  };
  const entry: ToolResultEntry = {
    index: 0,
    message,
    value,
    serialized: serializeToolResult(value),
    call: { tool: toolName, args, step: 0 },
    step: 0,
    currentTurn: true
  };
  const projected = projectValue(entry, true, options.thresholdBytes ?? defaultProjectionThresholdBytes);
  if (projected === undefined) return value;
  const before = serializeToolResult(value);
  const after = serializeToolResult(projected.value);
  if (before === after && projected.archive === false) return value;
  if (!projected.archive) return projected.value;

  const archived = await archiveEntry(entry, options);
  return attachProjectionMetadata(projected.value, {
    originalBytes: Buffer.byteLength(before, "utf8"),
    retainedBytes: Buffer.byteLength(after, "utf8"),
    archivePath: archived.archivePath,
    archiveError: archived.error,
    originalValue: value,
    tool: toolName
  });
}

/**
 * 为下一次模型请求生成工具结果视图。
 *
 * 语义替代只在当前用户消息之后发生，并且不同 assistant step 之间才生效；同一 step 的
 * 并行工具结果不会相互覆盖。未知工具没有可证明的语义关系，只做完全重复去重。
 */
export async function projectToolResultsForModel(
  messages: AgentMessage[],
  options: ToolResultProjectionOptions = {}
): Promise<AgentMessage[]> {
  const entries = collectToolResults(messages);
  if (!entries.length) return messages;

  const thresholdBytes = options.thresholdBytes ?? defaultProjectionThresholdBytes;
  const keepRecentResults = Math.max(0, options.keepRecentResults ?? defaultKeepRecentResults);
  const recentEntries = keepRecentResults > 0
    ? entries.filter((entry) => entry.currentTurn).slice(-keepRecentResults)
    : [];
  const recentIndexes = new Set(
    recentEntries.map((entry) => entry.index)
  );
  if (!recentIndexes.size && keepRecentResults > 0) {
    for (const entry of entries.slice(-keepRecentResults)) recentIndexes.add(entry.index);
  }

  const replacements = findReplacements(entries);
  const projected = [...messages];
  let changed = false;
  for (const entry of entries) {
    const replacement = replacements.get(entry.index);
    if (replacement) {
      const marker = await replacementMessage(entry, replacement, options);
      projected[entry.index] = marker;
      changed = true;
      continue;
    }

    const projectedValue = projectValue(entry, !recentIndexes.has(entry.index), thresholdBytes);
    if (projectedValue === undefined) continue;
    const before = serializeToolResult(entry.value);
    const after = serializeToolResult(projectedValue.value);
    if (before === after && projectedValue.archive === false) continue;

    let value = projectedValue.value;
    if (projectedValue.archive) {
      const archived = await archiveEntry(entry, options);
      value = attachProjectionMetadata(value, {
        originalBytes: Buffer.byteLength(before, "utf8"),
        retainedBytes: Buffer.byteLength(after, "utf8"),
        archivePath: archived.archivePath,
        archiveError: archived.error,
        originalValue: entry.value,
        tool: entry.message.toolName
      });
    }
    projected[entry.index] = projectedToolResultMessage(entry.message, value);
    changed = true;
  }
  return changed ? projected : messages;
}

function collectToolResults(messages: AgentMessage[]): ToolResultEntry[] {
  const calls = new Map<string, ToolCallInfo>();
  const entries: ToolResultEntry[] = [];
  let latestUserIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      latestUserIndex = index;
      continue;
    }
    if (message.role === "assistant") {
      const callsInMessage = message.content.filter(isToolCall);
      for (const call of callsInMessage) {
        calls.set(call.id, { tool: call.name, args: call.arguments, step: index });
      }
      continue;
    }
    const call = calls.get(message.toolCallId);
    const value = toolResultValue(message);
    entries.push({
      index,
      message,
      value,
      serialized: serializeToolResult(value),
      call,
      step: call?.step ?? index,
      currentTurn: false
    });
  }
  for (const entry of entries) entry.currentTurn = entry.index > latestUserIndex;
  return entries;
}

function findReplacements(entries: readonly ToolResultEntry[]): Map<number, Replacement> {
  const replacements = new Map<number, Replacement>();
  const exact = new Map<string, ToolResultEntry>();
  const reads: ToolResultEntry[] = [];
  const snapshots = new Map<string, ToolResultEntry>();
  const failures = new Map<string, ToolResultEntry[]>();

  for (const entry of entries.filter((candidate) => candidate.currentTurn)) {
    const callKey = entry.call ? `${entry.call.tool}\0${stableJson(entry.call.args)}` : undefined;
    const exactKey = callKey === undefined ? undefined : `${callKey}\0${resultSignature(entry)}`;
    const previousExact = exactKey === undefined ? undefined : exact.get(exactKey);
    if (previousExact && previousExact.step !== entry.step) {
      markReplacement(replacements, previousExact.index, "duplicate", false);
    }
    if (exactKey !== undefined) exact.set(exactKey, entry);

    const read = readRange(entry);
    if (read && isSuccessfulToolResult(entry)) {
      for (const previous of reads) {
        if (previous.step === entry.step) continue;
        const previousRange = readRange(previous);
        if (previousRange && rangeCovers(read, previousRange)) {
          markReplacement(replacements, previous.index, "read_covered", true);
        }
      }
      reads.push(entry);
    }

    const snapshot = snapshotKind(entry);
    if (snapshot && isSuccessfulToolResult(entry)) {
      const previous = snapshots.get(snapshot);
      if (previous && previous.step !== entry.step) {
        markReplacement(replacements, previous.index, "snapshot_replaced", true);
      }
      snapshots.set(snapshot, entry);
    }

    if (callKey !== undefined && isKnownSemanticTool(entry)) {
      const previousFailures = failures.get(callKey) ?? [];
      if (previousFailures.length && isSuccessfulToolResult(entry)) {
        for (const previousFailure of previousFailures) {
          if (previousFailure.step !== entry.step) markReplacement(replacements, previousFailure.index, "failure_resolved", false);
        }
      }
      if (isFailedToolResult(entry)) failures.set(callKey, [...previousFailures, entry]);
    }
  }
  return replacements;
}

function markReplacement(
  replacements: Map<number, Replacement>,
  index: number,
  reason: ReplacementReason,
  archive: boolean
): void {
  const current = replacements.get(index);
  replacements.set(index, {
    reason: current?.reason ?? reason,
    archive: Boolean(current?.archive || archive)
  });
}

async function replacementMessage(
  entry: ToolResultEntry,
  replacement: Replacement,
  options: ToolResultProjectionOptions
): Promise<AgentToolResultMessage> {
  const archived = replacement.archive ? await archiveEntry(entry, options) : {};
  const lines = [
    projectionMarker,
    `Tool: ${entry.message.toolName}`,
    `Reason: ${replacementReason(replacement.reason)}`
  ];
  if (archived.archivePath) {
    lines.push(
      `Archived result: ${archived.archivePath}`,
      "Use read_tool_result with this archivePath if the earlier value is needed."
    );
  } else {
    lines.push("The complete earlier result remains in durable session history.");
  }
  if (archived.error) lines.push(`Archive error: ${archived.error}`);
  const message = replacement.reason === "failure_resolved"
    ? { ...entry.message, isError: false }
    : entry.message;
  return projectedToolResultMessage(message, {
    modelProjection: "replacement",
    reason: replacement.reason,
    archivePath: archived.archivePath,
    archiveError: archived.error,
    summary: lines.join("\n")
  });
}

async function archiveEntry(
  entry: ToolResultEntry,
  options: ToolResultProjectionOptions
): Promise<{ archivePath?: string; error?: string }> {
  const existing = archivePath(entry.value);
  if (existing) return { archivePath: existing };
  if (!options.archiveResult) return {};
  try {
    const archived = await options.archiveResult({
      message: entry.message,
      result: entry.value,
      output: entry.serialized,
      sequence: options.sequence ?? entry.index + 1
    });
    return { archivePath: archived.archivePath };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

interface ValueProjection {
  value: unknown;
  archive: boolean;
}

function projectValue(
  entry: ToolResultEntry,
  aggressive: boolean,
  thresholdBytes: number
): ValueProjection | undefined {
  const tool = normalizedToolName(entry.message.toolName);
  const large = Buffer.byteLength(entry.serialized, "utf8") > thresholdBytes;
  if (isArchivedValue(entry.value)) return { value: entry.value, archive: false };

  if (tool === "write" || tool === "edit" || Object.keys(asRecord(asRecord(entry.value).change)).length > 0) {
    return { value: projectFileChange(entry), archive: large };
  }
  if (tool === "bash") {
    if (asRecord(entry.value).background === true) return undefined;
    const value = projectRunCommand(entry, aggressive && large);
    return { value, archive: aggressive && large };
  }
  if (tool === "bashoutput") {
    if (!aggressive || !large) return undefined;
    return { value: projectBashOutput(entry), archive: true };
  }
  if (tool === "read") {
    if (!aggressive || !large) return undefined;
    return { value: projectReadFile(entry), archive: true };
  }
  if (tool === "grep") {
    if (!aggressive || !large) return undefined;
    return { value: projectSearchResult(entry), archive: true };
  }
  return undefined;
}

function projectFileChange(entry: ToolResultEntry): Record<string, unknown> {
  const record = asRecord(entry.value);
  const change = asRecord(record.change);
  const path = stringField(change, "path");
  const diff = stringField(change, "diff");
  const diffCounts = diffLineCounts(diff);
  const projected: Record<string, unknown> = {
    path: path || undefined,
    changeSummary: stringField(record, "changeSummary") || fileChangeSummary(entry.message.toolName, path),
    addedLines: diffCounts.added,
    deletedLines: diffCounts.deleted,
    operation: stringField(change, "operation") || undefined,
    ...copyFields(change, ["destinationPath", "committed", "server", "bytes", "edits", "firstChangedLine"]),
    ...copyFields(record, [
      "status",
      "executionStatus",
      "error",
      "reason",
      "diagnostics",
      "stalePreview",
      "operationId",
      "recovered",
      "durationMs"
    ])
  };
  return removeUndefined(projected);
}

function projectRunCommand(entry: ToolResultEntry, aggressive: boolean): Record<string, unknown> {
  const record = asRecord(entry.value);
  const args = asRecord(entry.call?.args);
  const command = stringField(args, "command");
  const rawStdout = stripCommandEcho(stringField(record, "stdout"), command);
  const rawStderr = stripCommandEcho(stringField(record, "stderr"), command);
  const stdout = aggressive ? tailText(rawStdout, maxCommandStreamCharacters) : rawStdout;
  const stderr = aggressive ? tailText(rawStderr, maxCommandStreamCharacters) : rawStderr;
  const stdoutBytes = numberField(record, "stdoutBytes") ?? Buffer.byteLength(rawStdout, "utf8");
  const stderrBytes = numberField(record, "stderrBytes") ?? Buffer.byteLength(rawStderr, "utf8");
  const stdoutTruncated = record.stdoutTruncated === true
    || aggressive && Buffer.byteLength(stdout, "utf8") < Buffer.byteLength(rawStdout, "utf8");
  const stderrTruncated = record.stderrTruncated === true
    || aggressive && Buffer.byteLength(stderr, "utf8") < Buffer.byteLength(rawStderr, "utf8");
  return removeUndefined({
    ...copyFields(record, [
      "status",
      "sandbox",
      "exitCode",
      "error",
      "durationMs",
      "outputLines"
    ]),
    stdout: stdout || undefined,
    stderr: stderr || undefined,
    stdoutBytes,
    stdoutRetainedBytes: Buffer.byteLength(stdout, "utf8"),
    stdoutTruncated,
    stdoutTruncationDirection: stdoutTruncated ? "tail" : undefined,
    stderrBytes,
    stderrRetainedBytes: Buffer.byteLength(stderr, "utf8"),
    stderrTruncated,
    stderrTruncationDirection: stderrTruncated ? "tail" : undefined,
    summary: stdoutTruncated || stderrTruncated || aggressive
      ? commandSummary(record, stdoutTruncated, stderrTruncated)
      : undefined
  });
}

function projectReadFile(entry: ToolResultEntry): Record<string, unknown> {
  const record = asRecord(entry.value);
  const args = asRecord(entry.call?.args);
  const resultRange = asRecord(record.range);
  const argsRange = asRecord(args.range);
  const path = stringField(record, "path") || stringField(args, "path");
  const content = stringField(record, "content");
  const displayed = tailTextWithHead(content, maxReadContentCharacters);
  const truncated = displayed.length < content.length;
  return removeUndefined({
    path: path || undefined,
    content: displayed,
    contentTruncated: truncated ? true : undefined,
    contentOriginalBytes: truncated ? Buffer.byteLength(content, "utf8") : undefined,
    contentRetainedBytes: truncated ? Buffer.byteLength(displayed, "utf8") : undefined,
    contentTruncationDirection: truncated ? "head_and_tail" : undefined,
    summary: truncated ? "Only the necessary head and tail of this file are shown; the full result is available via read_tool_result." : undefined,
    startLine: numberField(record, "startLine")
      ?? numberField(record, "lineStart")
      ?? numberField(resultRange, "startLine")
      ?? numberField(resultRange, "start")
      ?? numberField(args, "startLine")
      ?? numberField(args, "lineStart")
      ?? numberField(argsRange, "startLine")
      ?? numberField(argsRange, "start"),
    endLine: numberField(record, "endLine")
      ?? numberField(record, "lineEnd")
      ?? numberField(resultRange, "endLine")
      ?? numberField(resultRange, "end")
      ?? numberField(args, "endLine")
      ?? numberField(args, "lineEnd")
      ?? numberField(argsRange, "endLine")
      ?? numberField(argsRange, "end"),
    offset: numberField(record, "offset") ?? numberField(args, "offset"),
    limit: numberField(record, "limit") ?? numberField(args, "limit"),
    hasMore: typeof record.hasMore === "boolean" ? record.hasMore : undefined,
    nextStartLine: numberField(record, "nextStartLine")
  });
}

function projectBashOutput(entry: ToolResultEntry): Record<string, unknown> {
  const record = asRecord(entry.value);
  const output = asRecord(record.output);
  const content = stringField(output, "content");
  const displayed = tailText(content, maxCommandStreamCharacters);
  const truncated = displayed.length < content.length;
  return removeUndefined({
    processes: Array.isArray(record.processes) ? record.processes : undefined,
    process: Object.keys(asRecord(record.process)).length > 0 ? record.process : undefined,
    output: Object.keys(output).length > 0
      ? removeUndefined({
          ...copyFields(output, ["processId", "logPath", "startOffset", "nextOffset", "totalBytes", "omittedBefore", "hasMore"]),
          content: displayed,
          contentTruncated: truncated ? true : undefined,
          contentOriginalBytes: truncated ? Buffer.byteLength(content, "utf8") : undefined,
          contentRetainedBytes: truncated ? Buffer.byteLength(displayed, "utf8") : undefined,
          contentTruncationDirection: truncated ? "tail" : undefined
        })
      : undefined,
    summary: truncated ? "Only the tail of this output page is shown; the full result is available via read_tool_result." : undefined
  });
}

function projectSearchResult(entry: ToolResultEntry): Record<string, unknown> {
  const record = asRecord(entry.value);
  const rawMatches = Array.isArray(record.matches) ? record.matches : [];
  const matches: unknown[] = [];
  let retainedBytes = 0;
  for (const match of rawMatches) {
    const item = asRecord(match);
    const text = stringField(item, "text");
    const bounded = text.length > maxSearchMatchCharacters ? `${safePrefix(text, maxSearchMatchCharacters)}…` : text;
    const next = removeUndefined({
      path: stringField(item, "path") || undefined,
      line: numberField(item, "line"),
      column: numberField(item, "column"),
      anchor: stringField(item, "anchor") || undefined,
      text: bounded,
      before: projectSearchContext(item.before),
      after: projectSearchContext(item.after)
    });
    const nextBytes = Buffer.byteLength(serializeToolResult(next), "utf8");
    if (retainedBytes + nextBytes > maxSearchOutputBytes && matches.length > 0) break;
    matches.push(next);
    retainedBytes += nextBytes;
  }
  const truncated = matches.length < rawMatches.length || retainedBytes < Buffer.byteLength(serializeToolResult(rawMatches), "utf8");
  return removeUndefined({
    matches,
    matchCount: rawMatches.length,
    ...copyFields(record, [
      "offset",
      "limit",
      "hasMore",
      "nextOffset",
      "scannedFiles",
      "skippedFiles",
      "fileLimitReached"
    ]),
    matchesTruncated: truncated ? true : undefined,
    matchesRetainedBytes: truncated ? retainedBytes : undefined,
    summary: truncated ? "Only bounded match locations and snippets are shown; the full search result is available via read_tool_result." : undefined
  });
}

function projectSearchContext(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((line) => {
    const item = asRecord(line);
    const text = stringField(item, "text");
    return removeUndefined({
      line: numberField(item, "line"),
      text: text.length > maxSearchMatchCharacters ? `${safePrefix(text, maxSearchMatchCharacters)}…` : text
    });
  });
}

function attachProjectionMetadata(
  value: unknown,
  metadata: {
    originalBytes: number;
    retainedBytes: number;
    archivePath?: string;
    archiveError?: string;
    originalValue?: unknown;
    tool: string;
  }
): unknown {
  const record = asRecord(value);
  const base = Object.keys(record).length ? record : { result: value };
  const compactSummary = stringField(record, "summary");
  const summary = compactSummary
    ? `${compactSummary}${metadata.archivePath ? ` Full result: read_tool_result ${metadata.archivePath}.` : metadata.archiveError ? ` Archiving failed (${metadata.archiveError}); the complete result remains in session history.` : " The complete result remains in session history."}`
    : metadata.archivePath
      ? `Only a compact ${metadata.tool} result is shown; the full result is available via read_tool_result at ${metadata.archivePath}.`
      : metadata.archiveError
        ? `Only a compact ${metadata.tool} result is shown. Archiving failed (${metadata.archiveError}); the complete result remains in session history.`
        : `Only a compact ${metadata.tool} result is shown; the complete result remains in session history.`;
  return removeUndefined({
    ...base,
    archived: metadata.archivePath !== undefined,
    archivePath: metadata.archivePath,
    archiveError: metadata.archiveError,
    result: metadata.archiveError ? metadata.originalValue : undefined,
    resultBytes: metadata.originalBytes,
    retainedBytes: metadata.retainedBytes,
    resultFingerprint: createHash("sha256").update(serializeToolResult(metadata.originalValue ?? value)).digest("hex"),
    summary
  });
}

function projectedToolResultMessage(message: AgentToolResultMessage, value: unknown): AgentToolResultMessage {
  return {
    ...message,
    content: [{ type: "text", text: serializeToolResult(value) }],
    details: value
  };
}

function toolResultValue(message: AgentToolResultMessage): unknown {
  if (message.details !== undefined) return message.details;
  const text = message.content
    .filter((part): part is Extract<AgentToolResultMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isToolCall(part: AgentAssistantMessage["content"][number]): part is AgentToolCallContent {
  return part.type === "toolCall";
}

function readRange(entry: ToolResultEntry): ReadRange | undefined {
  if (normalizedToolName(entry.message.toolName) !== "read") return undefined;
  const args = asRecord(entry.call?.args);
  const result = asRecord(entry.value);
  const argsRange = asRecord(args.range);
  const resultRange = asRecord(result.range);
  const path = stringField(args, "path") || stringField(result, "path");
  if (!path) return undefined;
  const startLine = numberField(result, "startLine")
    ?? numberField(result, "lineStart")
    ?? numberField(result, "start")
    ?? numberField(resultRange, "startLine")
    ?? numberField(resultRange, "start")
    ?? numberField(args, "startLine")
    ?? numberField(args, "lineStart")
    ?? numberField(args, "start")
    ?? numberField(argsRange, "startLine")
    ?? numberField(argsRange, "start");
  const endLine = numberField(result, "endLine")
    ?? numberField(result, "lineEnd")
    ?? numberField(result, "end")
    ?? numberField(resultRange, "endLine")
    ?? numberField(resultRange, "end")
    ?? numberField(args, "endLine")
    ?? numberField(args, "lineEnd")
    ?? numberField(args, "end")
    ?? numberField(argsRange, "endLine")
    ?? numberField(argsRange, "end");
  if (startLine !== undefined || endLine !== undefined) {
    return { path: normalizePath(path), kind: "line", start: startLine ?? 1, end: endLine ?? Number.MAX_SAFE_INTEGER };
  }
  const offset = numberField(result, "offset") ?? numberField(args, "offset");
  const limit = numberField(result, "limit") ?? numberField(args, "limit");
  if (offset !== undefined || limit !== undefined) {
    return { path: normalizePath(path), kind: "offset", start: offset ?? 0, end: (offset ?? 0) + (limit ?? Number.MAX_SAFE_INTEGER) };
  }
  return { path: normalizePath(path), kind: "full", start: 0, end: Number.MAX_SAFE_INTEGER };
}

function rangeCovers(next: ReadRange, previous: ReadRange): boolean {
  return next.path === previous.path
    && (next.kind === "full" || next.kind === previous.kind && next.start <= previous.start && next.end >= previous.end);
}

function snapshotKind(entry: ToolResultEntry): string | undefined {
  const tool = normalizedToolName(entry.message.toolName);
  if (tool !== "bash") return undefined;
  const args = asRecord(entry.call?.args);
  if (args.background === true) return undefined;
  const command = stringField(args, "command").trim().replace(/^(?:sudo\s+)/u, "");
  const match = command.match(/^(?:git\s+)(status|diff|log|show)(?:\s|$)/iu);
  if (!match?.[1]) return undefined;
  return `${match[1].toLowerCase()}\0${normalizePath(stringField(args, "cwd") || ".")}`;
}

function isFailedToolResult(entry: ToolResultEntry): boolean {
  if (entry.message.isError === true) return true;
  const record = asRecord(entry.value);
  const output = stringField(record, "output").trim();
  return typeof record.error === "string"
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.approved === false
    || typeof record.exitCode === "number" && record.exitCode !== 0
    || /^(?:fatal|error|failed)(?:[:\s]|$)/iu.test(output);
}

function isSuccessfulToolResult(entry: ToolResultEntry): boolean {
  if (isFailedToolResult(entry)) return false;
  const record = asRecord(entry.value);
  return record.status === undefined
    || record.status === "completed"
    || record.status === "succeeded"
    || record.executionStatus === "succeeded"
    || record.exitCode === 0;
}

function isArchivedValue(value: unknown): boolean {
  const record = asRecord(value);
  return record.archived === true && typeof record.archivePath === "string";
}

function archivePath(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = stringField(record, "archivePath");
  if (direct && archivePathPattern.test(direct)) return direct;
  const text = serializeToolResult(value);
  return text.match(archivePathPattern)?.[0];
}

function resultSignature(entry: ToolResultEntry): string {
  const fingerprint = stringField(asRecord(entry.value), "resultFingerprint");
  return fingerprint || entry.serialized;
}

function replacementReason(reason: ReplacementReason): string {
  if (reason === "duplicate") return "an identical tool call and result was already retained";
  if (reason === "read_covered") return "a later read covers this earlier file range";
  if (reason === "snapshot_replaced") return "a later Git snapshot supersedes this earlier snapshot";
  return "a later successful result resolved this earlier failure";
}

function fileChangeSummary(tool: string, filePath: string): string {
  const action = tool.toLowerCase().includes("write") ? "Write" : "Edit";
  return `${action}${filePath ? ` ${filePath}` : " file"}`;
}

function normalizedToolName(tool: string): string {
  return tool.toLowerCase().replace(/[\s-]+/gu, "_");
}

function isKnownSemanticTool(entry: ToolResultEntry): boolean {
  const tool = normalizedToolName(entry.message.toolName);
  return tool === "write"
    || tool === "edit"
    || tool === "bash"
    || tool === "bashoutput"
    || tool === "killshell"
    || tool === "read"
    || tool === "grep";
}

function diffLineCounts(diff: string): { added?: number; deleted?: number } {
  if (!diff) return {};
  let added = 0;
  let deleted = 0;
  let found = false;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) { added += 1; found = true; }
    if (line.startsWith("-")) { deleted += 1; found = true; }
  }
  return found ? { added, deleted } : {};
}

function commandSummary(
  record: Record<string, unknown>,
  stdoutTruncated: boolean,
  stderrTruncated: boolean
): string {
  const status = stringField(record, "status") || (numberField(record, "exitCode") === 0 ? "completed" : "failed");
  const exitCode = numberField(record, "exitCode");
  const exit = exitCode === undefined ? "unknown exit code" : `exit code ${String(exitCode)}`;
  const streams = [stdoutTruncated ? "stdout tail" : "stdout", stderrTruncated ? "stderr tail" : "stderr"].join("/");
  return `Shell command ${status}, ${exit}; showing ${streams}. Full output is available via read_tool_result when an archivePath is present.`;
}

function stripCommandEcho(value: string, command: string): string {
  if (!value || !command) return value;
  return value
    .split(/\r?\n/u)
    .filter((line) => {
      const normalized = line.trim().replace(/^\$\s*/u, "");
      return normalized !== command.trim()
        && normalized !== `Command: ${command.trim()}`
        && normalized !== `Started: ${command.trim()}`;
    })
    .join("\n");
}

function tailText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  let start = Math.max(0, value.length - maxCharacters);
  if (isLowSurrogate(value.charCodeAt(start))) start += 1;
  return value.slice(start);
}

function tailTextWithHead(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const head = Math.floor(maxCharacters / 2);
  const tail = maxCharacters - head;
  const headText = isHighSurrogate(value.charCodeAt(head - 1)) ? value.slice(0, head - 1) : value.slice(0, head);
  return `${headText}\n… [file content omitted] …\n${tailText(value, tail)}`;
}

function safePrefix(value: string, maxCharacters: number): string {
  let end = Math.min(value.length, Math.max(0, maxCharacters));
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] as string : "";
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
}

function copyFields(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function removeUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
