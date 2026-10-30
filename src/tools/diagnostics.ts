/**
 * 编辑后诊断模块。
 *
 * 没有它，模型的编辑是开环的：改完不知道对不对，只能自己想起来跑一次全量检查，而那既慢
 * 又要占工具结果预算，模型经常就不跑了。这里在每次写入/编辑成功后自动跑一次项目自己的
 * 检查命令，把结果直接挂在该次工具结果上，让"改错了"在下一步就被看见。
 *
 * 两条设计约束：
 * - **只用项目里已装好的可执行文件**。绝不走 `npx` 之类会联网安装的路径 —— agent 的自动
 *   行为不该在用户机器上装东西。找不到就静默跳过。
 * - **同一条命令不并发跑**。写入是并行的，天真实现会把 tsc 同时拉起好几个。在跑的时候
 *   来的请求合并到下一轮，保证每个请求拿到的都是能看见自己那次写入的结果。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DiagnosticsConfig } from "../config/schema.js";
import { runShellCommand } from "./shell/runCommand.js";

export interface DiagnosticsOutcome {
  command: string;
  exitCode: number;
  /** 已按 maxOutputBytes 截断的合并输出。 */
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

interface PendingRun {
  promise: Promise<DiagnosticsOutcome>;
  /** 尚未开始的排队轮次可以被后来者合并。 */
  queued: boolean;
}

export class DiagnosticsRunner {
  private readonly running = new Map<string, PendingRun>();

  constructor(private readonly workspaceRoot: string, private readonly config: DiagnosticsConfig) {}

  /** 该路径对应的检查命令；没有配置、没装好或扩展名不匹配时返回 undefined。 */
  resolveCommand(filePath: string): { command: string; timeoutMs: number } | undefined {
    if (!this.config.enabled) return undefined;
    const extension = path.extname(filePath).toLowerCase();
    if (!extension) return undefined;
    const configured = this.config.commands.find((entry) => entry.extensions.some((value) => value.toLowerCase() === extension));
    if (configured) return { command: configured.command, timeoutMs: configured.timeoutMs };
    return this.config.autoDetect ? this.autoDetected(extension) : undefined;
  }

  async run(filePath: string, signal?: AbortSignal): Promise<DiagnosticsOutcome | undefined> {
    const resolved = this.resolveCommand(filePath);
    if (!resolved) return undefined;
    return await this.singleFlight(resolved.command, resolved.timeoutMs, signal);
  }

  private async singleFlight(command: string, timeoutMs: number, signal?: AbortSignal): Promise<DiagnosticsOutcome> {
    const active = this.running.get(command);
    // 已经排队但还没开跑的那一轮一定会看见我们刚写的内容，直接合并进去。
    if (active?.queued) return await active.promise;

    const pending: PendingRun = { queued: true, promise: Promise.resolve() as unknown as Promise<DiagnosticsOutcome> };
    pending.promise = (async () => {
      // 等在跑的那一轮结束，否则同一条命令会并发拉起多个进程。
      if (active) await active.promise.catch(() => undefined);
      pending.queued = false;
      try {
        return await this.execute(command, timeoutMs, signal);
      } finally {
        if (this.running.get(command) === pending) this.running.delete(command);
      }
    })();
    this.running.set(command, pending);
    return await pending.promise;
  }

  private async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<DiagnosticsOutcome> {
    const result = await runShellCommand(this.workspaceRoot, command, { timeoutMs, signal });
    const merged = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n").trim();
    const limit = this.config.maxOutputBytes;
    const localClipped = Buffer.byteLength(merged, "utf8") > limit;
    const truncated = localClipped || result.stdoutTruncated === true || result.stderrTruncated === true;
    const output = localClipped ? new StringDecoder("utf8").write(Buffer.from(merged, "utf8").subarray(0, limit)) : merged;
    return {
      command,
      exitCode: result.exitCode,
      // 编译器把最有用的信息放在前面，超限时留头部。
      output: truncated ? `${output}\n[diagnostics output truncated]` : output,
      truncated,
      timedOut: result.status === "timed_out"
    };
  }

  /**
   * 只认项目本地已安装的 TypeScript。用 `node_modules/.bin/tsc` 而不是 `npx tsc`：后者在
   * 没装的时候会去下载，那不是一个自动触发的行为该做的事。
   */
  private autoDetected(extension: string): { command: string; timeoutMs: number } | undefined {
    if (![".ts", ".tsx", ".mts", ".cts"].includes(extension)) return undefined;
    if (!existsSync(path.join(this.workspaceRoot, "tsconfig.json"))) return undefined;
    const binary = path.join(this.workspaceRoot, "node_modules", ".bin", "tsc");
    if (!existsSync(binary)) return undefined;
    const quotedBinary = process.platform === "win32"
      ? `"${binary}"`
      : `'${binary.replace(/'/gu, "'\\''")}'`;
    return { command: `${quotedBinary} --noEmit`, timeoutMs: this.config.autoDetectTimeoutMs };
  }
}

/** 挂在工具结果上的诊断信息；无错误时也回报，让模型确认改动是干净的。 */
export function formatDiagnostics(outcome: DiagnosticsOutcome): Record<string, unknown> {
  if (outcome.timedOut) {
    return { command: outcome.command, status: "timed_out", hint: "The project check did not finish in time; run it yourself if the change is risky." };
  }
  if (outcome.exitCode === 0) return { command: outcome.command, status: "clean" };
  return {
    command: outcome.command,
    status: "failed",
    exitCode: outcome.exitCode,
    output: outcome.output,
    truncated: outcome.truncated
  };
}
