import { CodeModeToolError, experimental_runCodeMode } from "@ai-sdk/code-mode";
import { jsonSchema, tool } from "ai";
import type { AgentTool, AgentToolResult } from "./core/types.js";

/** Code Mode is deliberately limited to reviewed, built-in, read-only tools. */
export const codeModeNestedToolNames = new Set(["Read", "Glob", "Grep", "read_tool_result", "recall_memory", "search_history"]);

export const codeModePolicy = Object.freeze({
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 2 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxConsoleOutputBytes: 1,
  maxSourceBytes: 64 * 1024,
  maxToolInputBytes: 1024 * 1024,
  maxToolOutputBytes: 1024 * 1024,
  maxBridgeRequests: 32,
  maxInFlightBridgeRequests: 8
});
const hostDrainTimeoutMs = 500;

export interface CodeModeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  outcomeUnknown?: boolean;
  childCalls: Array<{ tool: string; toolCallId: string }>;
}

/**
 * Only the QuickJS worker receives source. Host tools remain behind the caller's
 * coordinator; the worker has no Node filesystem, network or process globals.
 * A cell is never replayed on failure because some child calls may have run.
 */
export async function executeCodeModeCell(input: {
  code: string;
  parentToolCallId: string;
  tools: readonly AgentTool[];
  signal?: AbortSignal;
  isCurrent: (name: string, tool: AgentTool) => boolean;
  onUnsettled?: (operations: readonly { toolCallId: string; settlement: Promise<unknown> }[]) => void;
  /** Tests may tighten, but never widen, the complete production policy. */
  executionPolicy?: Readonly<typeof codeModePolicy>;
}): Promise<CodeModeResult> {
  const policy = input.executionPolicy ?? codeModePolicy;
  for (const key of Object.keys(codeModePolicy) as Array<keyof typeof codeModePolicy>) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > codeModePolicy[key]) {
      throw new Error(`Invalid Code Mode limit: ${key}`);
    }
  }
  const active = new Map(input.tools
    .filter((entry) => codeModeNestedToolNames.has(entry.name))
    .map((entry) => [entry.name, entry] as const));
  const childCalls: CodeModeResult["childCalls"] = [];
  const pending = new Map<Promise<unknown>, string>();
  const bridgeAbort = new AbortController();
  let closed = false;
  let fatalError: string | undefined;
  const toolSet: Parameters<typeof experimental_runCodeMode>[0]["tools"] = Object.create(null);
  for (const [name, entry] of active) {
    toolSet[name] = tool({
      inputSchema: jsonSchema(entry.parameters),
      execute: async (args, options) => {
        const signal = options.abortSignal
          ? input.signal ? AbortSignal.any([input.signal, options.abortSignal, bridgeAbort.signal]) : AbortSignal.any([options.abortSignal, bridgeAbort.signal])
          : input.signal ? AbortSignal.any([input.signal, bridgeAbort.signal]) : bridgeAbort.signal;
        signal.throwIfAborted();
        if (closed) throw new CodeModeToolError("Code Mode cell has already ended.", { toolName: name });
        if (fatalError) throw new CodeModeToolError(fatalError, { toolName: name });
        if (!input.isCurrent(name, entry)) throw new CodeModeToolError(`Tool ${name} is no longer available in this cell.`, { toolName: name });
        const toolCallId = `${input.parentToolCallId}:nested:${String(childCalls.length + 1)}`;
        childCalls.push({ tool: name, toolCallId });
        const operation = entry.execute(toolCallId, args as Record<string, unknown>, signal);
        pending.set(operation, toolCallId);
        try {
          const result: AgentToolResult = await operation;
          if (closed) return { status: "unknown", late: true };
          if (result.isError) {
            fatalError = `Nested ${name} failed: ${String(JSON.stringify(result.details)).slice(0, 2_048)}`;
            throw new CodeModeToolError(fatalError, { toolName: name });
          }
          return result.details ?? result.content;
        } catch (error) {
          if (closed) return { status: "unknown", late: true };
          fatalError ??= error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          pending.delete(operation);
        }
      }
    });
  }
  let result: CodeModeResult;
  try {
    const value = await experimental_runCodeMode({
      js: input.code,
      tools: toolSet,
      toolExecutionOptions: { toolCallId: input.parentToolCallId, abortSignal: input.signal },
      options: { executionPolicy: policy }
    });
    result = fatalError
      ? { ok: false, error: fatalError, childCalls }
      : { ok: true, value: value ?? null, childCalls };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error), childCalls };
  }
  closed = true;
  const detachedChildren = pending.size > 0;
  bridgeAbort.abort(new Error("Code Mode cell ended."));
  if (!await drainHostOperations(pending, hostDrainTimeoutMs)) {
    input.onUnsettled?.([...pending].map(([settlement, toolCallId]) => ({ toolCallId, settlement })));
    return { ok: false, error: "A nested tool did not settle after Code Mode ended; its outcome is unknown. Do not replay this cell.", outcomeUnknown: true, childCalls };
  }
  if (result.ok && detachedChildren) {
    return { ok: false, error: "Code Mode returned before all nested tools settled; do not replay this cell.", childCalls };
  }
  return result;
}

async function drainHostOperations(operations: ReadonlyMap<Promise<unknown>, string>, timeoutMs: number): Promise<boolean> {
  if (operations.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...operations.keys()]).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function codeModeCatalog(tools: readonly AgentTool[]): string {
  return tools
    .filter((entry) => codeModeNestedToolNames.has(entry.name))
    .map((entry) => `${entry.name}: ${entry.description} ${JSON.stringify(entry.parameters)}`)
    .join("\n");
}
