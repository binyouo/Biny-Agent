/**
 * 工具钩子模块。
 *
 * 用户要表达"每次改完文件跑一下 X""提交前先跑测试"这类规则时，之前只能寄希望于在
 * `AGENTS.md` 里写一句然后指望模型记得。指望模型自觉不是机制 —— 钩子由 runtime 执行，
 * 不经过模型判断。
 *
 * 两个执行位点：
 * - `beforeTool`：工具执行前。非零退出会**阻止**这次调用，stderr 作为拒绝理由回给模型。
 *   这是用户能对 agent 行为下硬约束的地方。
 * - `afterTool`：工具执行后。输出附在工具结果上供模型参考，退出码不影响调用结果。
 *
 * 钩子命令来自用户的配置文件，按用户自己的权限执行，不经过权限确认 —— 它们代表的就是用户
 * 的意志。这一点在 README 里明确写出，配置钩子等同于信任那条命令。
 */
import type { HookConfig, HooksConfig } from "../config/schema.js";
import { runShellCommand, type ShellCompletionEvidence } from "./shell/runCommand.js";

export interface HookContext {
  tool: string;
  /** 触发钩子的工作区相对路径；取不到时为空串。 */
  path: string;
}

export interface HookOutcome {
  command: string;
  exitCode: number;
  output: string;
}

// Only HookRunner can attach authority. Public hook payloads remain unchanged,
// and an outcome copied or supplied by a caller cannot manufacture this proof.
const completionEvidence = new WeakMap<HookOutcome, ShellCompletionEvidence>();

export function readHookCompletionEvidence(outcome: HookOutcome): ShellCompletionEvidence {
  return completionEvidence.get(outcome) ?? "unconfirmed";
}

export class HookRunner {
  constructor(private readonly workspaceRoot: string, private readonly config: HooksConfig) {}

  hasHooks(event: "beforeTool" | "afterTool"): boolean {
    return this.config[event].length > 0;
  }

  /**
   * 返回第一个失败的钩子。调用方据此阻止（before）或附加说明（after）。
   * 钩子自身跑不起来（命令不存在等）按失败处理：配置了却没生效，比明确报错更危险。
   */
  async run(event: "beforeTool" | "afterTool", context: HookContext, signal?: AbortSignal): Promise<HookOutcome[]> {
    const matched = this.config[event].filter((hook) => matches(hook, context));
    const outcomes: HookOutcome[] = [];
    for (const hook of matched) {
      outcomes.push(await this.execute(hook, context, signal));
    }
    return outcomes;
  }

  private async execute(hook: HookConfig, context: HookContext, signal?: AbortSignal): Promise<HookOutcome> {
    try {
      let evidence: ShellCompletionEvidence = "unconfirmed";
      const result = await runShellCommand(this.workspaceRoot, hook.command, {
        timeoutMs: hook.timeoutMs,
        signal,
        onCompletionEvidence: (value) => { evidence = value; },
        // 钩子拿到触发它的工具和路径，才能写出有针对性的命令。
        env: { BINY_HOOK_TOOL: context.tool, BINY_HOOK_PATH: context.path }
      });
      const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n").trim();
      const outcome: HookOutcome = {
        command: hook.command,
        exitCode: result.status === "timed_out" ? 124 : result.exitCode,
        output: output.slice(0, maxHookOutputCharacters)
      };
      completionEvidence.set(outcome, evidence);
      return outcome;
    } catch (error) {
      // 取消属于调用生命周期；不能伪装成钩子拒绝，也不能继续后续钩子。
      signal?.throwIfAborted();
      return { command: hook.command, exitCode: 1, output: error instanceof Error ? error.message : String(error) };
    }
  }
}

const maxHookOutputCharacters = 4_000;

function matches(hook: HookConfig, context: HookContext): boolean {
  if (hook.tools.length && !hook.tools.includes(context.tool)) return false;
  if (!hook.extensions.length) return true;
  const lowered = context.path.toLowerCase();
  return hook.extensions.some((extension) => lowered.endsWith(extension.toLowerCase()));
}
