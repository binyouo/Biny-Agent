import { CodeModeToolError, experimental_runCodeMode } from "@ai-sdk/code-mode";
import { jsonSchema, tool } from "ai";
import type { AgentTool, AgentToolResult } from "./core/types.js";

/** Names are a VM surface bound; host registration provenance is checked separately. */
export const codeModeNestedToolNames = new Set(["Read", "Glob", "Grep",
  "TaskStatus", "BashOutput", "read_skill_resource", "Write", "Edit", "apply_patch", "Bash", "KillShell",
  "WebSearch", "WebFetch", "BrowserReadDom", "BrowserListEnvironments", "ChromeRelayStatus", "ChromeRelayListTabs", "ChromeRelayRead",
  "WidgetReadme", "read_checkpoint_evidence"]);

export const codeModePolicy = Object.freeze({
  /** Cumulative synchronous VM execution, excluding host/approval waits. */
  timeoutMs: 30_000,
  /** One nested coordinator pipeline, including its normal approval wait. */
  hostCallTimeoutMs: 300_000,
  /** Finite whole-cell deadline, including host waits and idle promises. */
  maxCellDurationMs: 600_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 2 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxConsoleOutputBytes: 1024 * 1024,
  maxSourceBytes: 64 * 1024,
  maxToolInputBytes: 1024 * 1024,
  maxToolOutputBytes: 1024 * 1024,
  maxBridgeRequests: 32,
  maxInFlightBridgeRequests: 8
});
export type CodeModeLimits = Readonly<{ [Limit in keyof typeof codeModePolicy]: number }>;
const hostDrainTimeoutMs = 500;

class RecoverableCodeModeToolError extends CodeModeToolError {}

export interface CodeModeResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  error?: string;
  outcomeUnknown?: boolean;
  childCalls: Array<{ tool: string; toolCallId: string }>;
}

export interface CodeModeSearchOptions {
  limit: number;
  namespace?: string;
  signal: AbortSignal;
  toolCallId: string;
  tools: readonly AgentTool[];
}

export type CodeModeSearch = (query: string, options: CodeModeSearchOptions) => Promise<readonly { name: string }[]>;

const discoveryBridgeNames = {
  invoke: "__biny_code_mode_invoke",
  search: "__biny_code_mode_search",
  tool: "__biny_code_mode_describe_tool",
  namespace: "__biny_code_mode_describe_namespace"
} as const;
const sourcePrefix = `return await (async (__binyHostTools)=>{
const tools=new Proxy(Object.create(null),{get(_target,name){return args=>__binyHostTools.${discoveryBridgeNames.invoke}({name:String(name),args});}});
const searchTools=(query,options={})=>__binyHostTools.${discoveryBridgeNames.search}({query,...options});
const describeTool=(name)=>__binyHostTools.${discoveryBridgeNames.tool}({name});
const describeNamespace=(name)=>__binyHostTools.${discoveryBridgeNames.namespace}({name});
const sh=async(command,options={})=>{
  if(typeof command!=="string"||!command)throw new Error("sh requires a command string");
  if(Object.keys(options).some(key=>!["cwd","timeoutMs"].includes(key)))throw new Error("sh supports cwd and timeoutMs only");
  const result=await tools.Bash({command,...options});
  if(result.exitCode!==0)throw new Error("Shell exited with "+result.exitCode+": "+String(result.stderr||result.stdout||"").slice(0,2000));
  return result.stdout;
};
const fetch=async(url,options={})=>{
  if(options.method&&options.method!=="GET"||Object.keys(options).some(key=>key!=="method"))throw new Error("fetch supports GET only; use sh with curl for other HTTP requests under Shell permissions");
  const result=await tools.WebFetch({url:String(url),raw:true,length:200000});
  if(result.hasMore||result.truncatedAtByteLimit)throw new Error("Response exceeds fetch limit; use tools.WebFetch with offset/length to page the response");
  return {ok:result.status>=200&&result.status<300,status:result.status,url:result.finalUrl,text:async()=>result.content,json:async()=>JSON.parse(result.content)};
};
const __binyValue=await(async()=>{\n`;
const sourceSuffix = "\n})();return {value:__binyValue??null};})(tools);";

/**
 * Only the QuickJS worker receives source. Host tools remain behind the caller's
 * coordinator; the worker has no Node filesystem, network or process globals.
 * A cell is never replayed on failure because some child calls may have run.
 */
export async function executeCodeModeCell(input: {
  code: string;
  language?: "javascript" | "typescript";
  timeoutMs?: number;
  archiveStdout?: (stdout: string) => Promise<string>;
  parentToolCallId: string;
  /** Existing callers supply reviewed built-ins here. */
  tools: readonly AgentTool[];
  /** The caller admits additional tools through its own permission and exposure policy. */
  admittedTools?: readonly AgentTool[];
  /** Refreshes the complete caller-approved inventory only when discovery needs it. */
  prepareTools?: (query?: string, signal?: AbortSignal) => Promise<readonly AgentTool[]>;
  /** Ordinary tools may be described and activated for the next model step, never invoked in this cell. */
  getModelTools?: () => readonly AgentTool[];
  /** Semantic matching reuses the caller's tool discovery implementation. */
  searchTools?: CodeModeSearch;
  signal?: AbortSignal;
  onToolResult?: (result: AgentToolResult) => void;
  isCurrent: (name: string, tool: AgentTool) => boolean;
  onUnsettled?: (operations: readonly { toolCallId: string; settlement: Promise<unknown> }[]) => void;
  /** Tests may tighten, but never widen, the complete production policy. */
  executionPolicy?: CodeModeLimits;
}): Promise<CodeModeResult> {
  const policy = { ...(input.executionPolicy ?? codeModePolicy) };
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > codeModePolicy.maxCellDurationMs)) throw new Error("Invalid script timeout_ms.");
  for (const key of Object.keys(codeModePolicy) as Array<keyof typeof codeModePolicy>) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > codeModePolicy[key]) {
      throw new Error(`Invalid Code Mode limit: ${key}`);
    }
  }
  policy.maxCellDurationMs = Math.min(policy.maxCellDurationMs, input.timeoutMs ?? 120_000);
  // Stock packages ignore executionTimeoutMs. A larger wall deadline is safe only
  // when both patched layers explicitly advertise the synchronous VM budget.
  const runner = experimental_runCodeMode as typeof experimental_runCodeMode & { executionTimeoutBudgetVersion?: number; consoleOutputVersion?: number };
  if (runner.executionTimeoutBudgetVersion !== 1 || runner.consoleOutputVersion !== 1) {
    return { ok: false, error: "Code Mode execution-time protection or streaming console support is unavailable. Install the pinned runtime patches before using Code Mode.", childCalls: [] };
  }
  const active = new Map([...input.tools.filter((entry) => codeModeNestedToolNames.has(entry.name)), ...(input.admittedTools ?? [])]
    .map((entry) => [entry.name, entry] as const));
  const childCalls: CodeModeResult["childCalls"] = [];
  const pending = new Map<Promise<unknown>, string>();
  const bridgeAbort = new AbortController();
  const cellAbortSignal = input.signal ? AbortSignal.any([input.signal, bridgeAbort.signal]) : bridgeAbort.signal;
  const hostTimers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let fatalError: string | undefined;
  let discoverySequence = 0;
  let invokeSequence = 0;
  const failDeadline = (message: string): void => {
    if (closed || cellAbortSignal.aborted) return;
    fatalError ??= message;
    bridgeAbort.abort(new Error(message));
  };
  const toolSet: Parameters<typeof experimental_runCodeMode>[0]["tools"] = Object.create(null);
  const cellSignal = (signal?: AbortSignal): AbortSignal => signal ? AbortSignal.any([cellAbortSignal, signal]) : cellAbortSignal;
  const availableTools = () => [...active.values()].filter((entry) => input.isCurrent(entry.name, entry));
  const discoveryTools = () => [...new Map([...(input.getModelTools?.() ?? []), ...availableTools()].map((entry) => [entry.name, entry])).values()]
    .filter((entry) => input.isCurrent(entry.name, entry));
  const describeDiscovered = (entry: AgentTool) => active.has(entry.name)
    ? toolDescription(entry) : { ...toolDescription(entry), invocation: "direct" };
  const assertOpen = (name: string, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (closed) throw new CodeModeToolError("Code Mode cell has already ended.", { toolName: name });
    if (fatalError !== undefined) throw new CodeModeToolError(fatalError, { toolName: name });
  };
  const refreshTools = async (query: string, signal: AbortSignal): Promise<void> => {
    if (!input.prepareTools) return;
    const prepared = await input.prepareTools(query, signal);
    assertOpen(query, signal);
    for (const entry of prepared) {
      if ((Object.values(discoveryBridgeNames) as string[]).includes(entry.name)) throw new Error(`Reserved Code Mode tool name: ${entry.name}`);
    }
    active.clear();
    for (const entry of [...input.tools.filter((entry) => codeModeNestedToolNames.has(entry.name)), ...prepared]) active.set(entry.name, entry);
  };
  const addBridge = (
    name: string,
    execute: (args: Record<string, unknown>, signal: AbortSignal, id: string, setOperationId: (id: string) => void) => unknown | Promise<unknown>
  ): void => {
    if (active.has(name)) throw new Error(`Reserved Code Mode tool name: ${name}`);
    toolSet[name] = tool({
      inputSchema: jsonSchema({ type: "object" }),
      async execute(args, options) {
        const signal = cellSignal(options.abortSignal);
        assertOpen(name, signal);
        const id = name === discoveryBridgeNames.invoke
          ? `${input.parentToolCallId}:preparing:${String(++invokeSequence)}`
          : `${input.parentToolCallId}:discovery:${String(++discoverySequence)}`;
        let operationId = id;
        const operationName = name === discoveryBridgeNames.invoke ? String(args.name) : name;
        const hostTimer = setTimeout(() => {
          failDeadline(`Nested ${operationName} (${operationId}) exceeded its ${String(policy.hostCallTimeoutMs)}ms host/approval deadline. Do not replay this cell.`);
        }, policy.hostCallTimeoutMs);
        hostTimers.add(hostTimer);
        const operation = Promise.resolve().then(() => execute(args as Record<string, unknown>, signal, id, (nextId) => {
          operationId = nextId;
          pending.set(operation, nextId);
        }));
        pending.set(operation, id);
        try {
          const value = await operation;
          if (closed) return { status: "unknown", late: true };
          return value;
        } catch (error) {
          if (closed) return { status: "unknown", late: true };
          const message = error instanceof Error ? error.message : String(error);
          if (!(error instanceof RecoverableCodeModeToolError) || signal.aborted) fatalError ??= message;
          throw new CodeModeToolError(fatalError ?? message, { toolName: name });
        } finally {
          clearTimeout(hostTimer);
          hostTimers.delete(hostTimer);
          pending.delete(operation);
        }
      }
    });
  };
  let stdout = "";
  let stdoutTruncated = false;
  addBridge(discoveryBridgeNames.invoke, async (args, signal, _id, setOperationId) => {
    const name = discoveryString(args.name, "tool name", 500);
    if ((Object.values(discoveryBridgeNames) as string[]).includes(name)) throw new Error(`Reserved Code Mode tool name: ${name}`);
    if (!args.args || typeof args.args !== "object" || Array.isArray(args.args)) throw new Error(`Invalid Code Mode arguments for ${name}.`);
    let entry = active.get(name);
    if (!entry) {
      await refreshTools(name, signal);
      entry = active.get(name);
    }
    assertOpen(name, signal);
    if (!entry || !input.isCurrent(name, entry)) throw new CodeModeToolError(`Tool ${name} is not available in this cell.`, { toolName: name });
    const toolCallId = `${input.parentToolCallId}:nested:${String(childCalls.length + 1)}`;
    childCalls.push({ tool: name, toolCallId });
    setOperationId(toolCallId);
    const result: AgentToolResult = await entry.execute(toolCallId, args.args as Record<string, unknown>, signal);
    input.onToolResult?.(result);
    if (result.isError) {
      const ErrorType = result.recoverableError === true ? RecoverableCodeModeToolError : CodeModeToolError;
      throw new ErrorType(`Nested ${name} failed: ${nestedToolFailurePreview(result.details)}`, { toolName: name });
    }
    return result.details ?? result.content;
  });
  addBridge(discoveryBridgeNames.search, async (args, signal, id) => {
    const query = discoveryString(args.query, "query", 500);
    const namespace = args.namespace === undefined ? undefined : discoveryString(args.namespace, "namespace", 500);
    const limit = args.limit ?? 8;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("searchTools limit must be an integer between 1 and 20.");
    }
    if (!input.searchTools) throw new Error("Code Mode tool discovery is not configured.");
    await refreshTools(namespace ?? query, signal);
    const candidates = discoveryTools().filter((entry) => namespace === undefined || entry.namespace?.name === namespace);
    const matches = await input.searchTools(query, { limit, namespace, signal, toolCallId: id, tools: candidates });
    signal.throwIfAborted();
    const unique = new Set<string>();
    const byName = new Map(candidates.map((entry) => [entry.name, entry]));
    return matches.flatMap(({ name }) => {
      const entry = byName.get(name);
      if (!entry || unique.has(name) || !input.isCurrent(name, entry) || unique.size >= limit) return [];
      unique.add(name);
      return [describeDiscovered(entry)];
    });
  });
  addBridge(discoveryBridgeNames.tool, async (args, signal) => {
    const name = discoveryString(args.name, "tool name", 500);
    await refreshTools(name, signal);
    const entry = discoveryTools().find((tool) => tool.name === name);
    return entry ? describeDiscovered(entry) : null;
  });
  addBridge(discoveryBridgeNames.namespace, async (args, signal) => {
    const name = discoveryString(args.name, "namespace", 500);
    await refreshTools(name, signal);
    const entries = discoveryTools().filter((entry) => entry.namespace?.name === name);
    const namespace = entries[0]?.namespace;
    return namespace ? { ...namespace, tools: entries.map(describeDiscovered) } : null;
  });
  const cellTimer = setTimeout(() => {
    failDeadline(`Code Mode exceeded its ${String(policy.maxCellDurationMs)}ms whole-cell deadline.`);
  }, policy.maxCellDurationMs);
  const { timeoutMs: vmTimeoutMs, hostCallTimeoutMs: _hostCallTimeoutMs, maxCellDurationMs: wallTimeoutMs, ...sandboxLimits } = policy;
  let result: CodeModeResult;
  try {
    if (Buffer.byteLength(input.code) > policy.maxSourceBytes) throw new Error("Code Mode source exceeds its byte limit.");
    let code = input.code;
    if (input.language === "typescript") {
      const { default: ts } = await import("typescript");
      const compiled = ts.transpileModule(`async function __binyTS(){\n${input.code}\n}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
      });
      const error = compiled.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
      if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
      code = compiled.outputText + "\nreturn await __binyTS();";
    }
    if (Buffer.byteLength(code) > policy.maxSourceBytes * 4) throw new Error("Compiled TypeScript exceeds its byte limit.");
    const value = await experimental_runCodeMode({
      js: sourcePrefix + code + sourceSuffix,
      onConsole: (event) => {
        stdout += event.text;
        stdoutTruncated ||= event.truncated;
      },
      tools: toolSet,
      toolExecutionOptions: { toolCallId: input.parentToolCallId, abortSignal: cellAbortSignal },
      options: { executionPolicy: {
        ...sandboxLimits,
        // 固定发现前缀不占用用户代码的源码字节预算。
        maxSourceBytes: Math.max(policy.maxSourceBytes, Buffer.byteLength(code)) + Buffer.byteLength(sourcePrefix + sourceSuffix),
        timeoutMs: wallTimeoutMs,
        executionTimeoutMs: vmTimeoutMs
      } }
    });
    cellAbortSignal.throwIfAborted();
    result = fatalError !== undefined
      ? { ok: false, error: fatalError, childCalls }
      : { ok: true, value: (value as { value?: unknown } | undefined)?.value ?? null, childCalls };
  } catch (error) {
    result = { ok: false, error: fatalError ?? (error instanceof Error ? error.message : String(error)), childCalls };
  } finally {
    clearTimeout(cellTimer);
    for (const timer of hostTimers) clearTimeout(timer);
    hostTimers.clear();
  }
  closed = true;
  const detachedChildren = pending.size > 0;
  bridgeAbort.abort(new Error("Code Mode cell ended."));
  if (!await drainHostOperations(pending, hostDrainTimeoutMs)) {
    input.onUnsettled?.([...pending].map(([settlement, toolCallId]) => ({ toolCallId, settlement })));
    result = { ok: false, error: "A nested tool did not settle after Code Mode ended; its outcome is unknown. Do not replay this cell.", outcomeUnknown: true, childCalls };
  }
  if (result.ok && detachedChildren) {
    result = { ok: false, error: "Code Mode returned before all nested tools settled; do not replay this cell.", childCalls };
  }
  // 取消或 VM 失败不清空宿主已经收到的输出。
  if (stdoutTruncated) stdout += "\n[Console capture limit reached; additional output is not retained.]";
  if (stdout.length > 16_000 && input.archiveStdout) {
    let previewEnd = 16_000;
    const last = stdout.charCodeAt(previewEnd - 1);
    const next = stdout.charCodeAt(previewEnd);
    // Keep the UTF-16 limit without cutting a valid surrogate pair in half.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) previewEnd--;
    const preview = stdout.slice(0, previewEnd);
    try {
      const archivePath = await input.archiveStdout(stdout);
      result.stdout = preview + `\n[Output truncated. Read ${stdoutTruncated ? "captured" : "full"} stdout at ${archivePath}]`;
    } catch (error) {
      result.ok = false;
      result.error = [result.error, `Stdout archiving failed: ${String(error)}. Do not replay this cell.`].filter(Boolean).join(" ");
      result.stdout = preview + "\n[Output truncated; archive unavailable]";
    }
  } else if (stdout) result.stdout = stdout;
  return result;
}

function nestedToolFailurePreview(details: unknown): string {
  // MCP 错误信封中的资源可能很长，优先保留文本原因，避免截断只留下资源正文。
  const content = typeof details === "object" && details !== null && "isError" in details && details.isError === true
    && "content" in details && Array.isArray(details.content) ? details.content : [];
  const text = content.flatMap((part: unknown) => typeof part === "object" && part !== null
    && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
  // 文本原因之外的剩余预算保留结构化恢复提示，不加入资源或二进制正文。
  if (text && text.length < 2_048 && typeof details === "object" && details !== null
    && "structuredContent" in details && details.structuredContent !== undefined) {
    return `${text}\n${JSON.stringify(details.structuredContent)}`.slice(0, 2_048);
  }
  return (text || String(JSON.stringify(details))).slice(0, 2_048);
}

function discoveryString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`Invalid Code Mode ${name}.`);
  return value.trim();
}

function toolSummary(entry: AgentTool) {
  return { name: entry.name, description: entry.description, namespace: entry.namespace?.name };
}

function toolDescription(entry: AgentTool) {
  return { ...toolSummary(entry), parameters: entry.parameters, outputSchema: entry.outputSchema, promptGuidelines: entry.promptGuidelines };
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
    .map((entry) => `${entry.name}: ${entry.description}`)
    .join("\n");
}
