import type { AgentSessionEvent } from "../agent/types.js";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SubagentTaskIncompleteError } from "../runtime/SubagentTaskManager.js";

export async function findClaudeSubagentCli(): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"]) {
      const executable = path.join(directory, name);
      try {
        if (!(await stat(executable)).isFile()) continue;
        await access(executable, constants.X_OK);
        return executable;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
  return undefined;
}

/** CLI owns its tools and authentication; stdout must prove completion independently of exit code. */
export async function runSubagentCli(options: {
  runtime: "codex" | "claude-code"; model?: string; command?: string; prompt: string; cwd: string; signal: AbortSignal;
  onActivity(): void;
  onEvent(event: AgentSessionEvent): Promise<void>;
}): Promise<string> {
  options.signal.throwIfAborted();
  const codex = options.runtime === "codex";
  if (codex && !options.model) throw new Error("Codex requires an explicit model.");
  const args = codex
    ? ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write"]
    : ["-p", "--verbose", "--output-format", "stream-json", "--no-session-persistence", "--permission-mode", "dontAsk"];
  if (options.model) args.push("--model", options.model);
  if (codex) args.push("-");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(options.command ?? (codex ? "codex" : "claude"), args, { cwd: options.cwd, env, stdio: "pipe", shell: false, detached: process.platform !== "win32", windowsHide: true });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
  };
  const stop = () => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
  };
  let failure: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => resolve(code));
  });
  const fail = (message: string) => { failure ??= new Error(message); stop(); };
  let bytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) fail("External CLI output exceeds the limit.");
  });
  child.stdin.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") { failure ??= error; stop(); } });
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  let output = "";
  let completed = false;
  let terminalError: string | undefined;
  let pending = "";
  const tools = new Map<string, { name: string; finished: boolean }>();
  const consume = async (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type?: string; subtype?: string; is_error?: boolean; result?: string; permission_denials?: unknown[];
      item?: { id?: string; type?: string; text?: string; status?: string; command?: string; exit_code?: number };
      message?: { content?: Array<{ type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }> }; error?: { message?: string } };
    if (codex && event.item?.id && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(event.item.type ?? "")) {
      const item = event.item;
      const id = item.id!;
      if (!tools.has(id)) {
        tools.set(id, { name: item.type!, finished: false });
        await options.onEvent({ type: "tool.started", tool: item.type!, toolCallId: id, args: item });
      }
      if (event.type === "item.completed") {
        tools.get(id)!.finished = true;
        await options.onEvent(item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0)
          ? { type: "tool.failed", tool: item.type!, toolCallId: id, error: "External tool failed.", result: item }
          : { type: "tool.completed", tool: item.type!, toolCallId: id, result: item });
      }
    }
    if (!codex && Array.isArray(event.message?.content)) for (const block of event.message.content) {
      if (block.type === "tool_use" && block.id && block.name) {
        tools.set(block.id, { name: block.name, finished: false });
        await options.onEvent({ type: "tool.started", tool: block.name, toolCallId: block.id, args: block.input });
      } else if (block.type === "tool_result" && block.tool_use_id && tools.has(block.tool_use_id)) {
        const tool = tools.get(block.tool_use_id)!;
        tool.finished = true;
        await options.onEvent(block.is_error
          ? { type: "tool.failed", tool: tool.name, toolCallId: block.tool_use_id, error: "External tool failed.", result: block.content }
          : { type: "tool.completed", tool: tool.name, toolCallId: block.tool_use_id, result: block.content });
      }
    }
    if (codex) {
      if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text ?? "";
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.failed" || event.type === "error") terminalError = "External CLI reported a failed turn.";
    } else if (event.type === "result") {
      output = event.result ?? "";
      completed = event.subtype === "success" && event.is_error === false && !event.permission_denials?.length;
      if (!completed) terminalError = event.permission_denials?.length ? "permission_denied" : "external_cli_error";
    }
  };
  try {
    child.stdin.end(options.prompt);
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > 16 * 1024 * 1024) throw new Error("External CLI output exceeds the limit.");
      options.onActivity();
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        if (Buffer.byteLength(pending.slice(0, newline)) > 1024 * 1024) throw new Error("External CLI message exceeds the limit.");
        await consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error("External CLI message exceeds the limit.");
    }
    if (pending) await consume(pending);
    const code = await exited;
    options.signal.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0) throw new Error(`External CLI exited with code ${String(code)}; task was not replayed.`);
    if (terminalError === "permission_denied") throw new SubagentTaskIncompleteError(terminalError, output);
    if (terminalError) throw new Error(terminalError);
    if ([...tools.values()].some(tool => !tool.finished)) throw new SubagentTaskIncompleteError("missing_terminal_event", output);
    if (!completed) throw new Error("External CLI has no successful terminal event; task was not replayed.");
    return output;
  } catch (error) {
    stop();
    await exited;
    options.signal.throwIfAborted();
    throw error instanceof SyntaxError ? new Error("External CLI returned invalid JSON; task was not replayed.") : error;
  } finally {
    options.signal.removeEventListener("abort", stop);
    if (killTimer) kill("SIGKILL");
    clearTimeout(killTimer);
  }
}
