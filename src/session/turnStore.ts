/**
 * 在途回合状态模块。
 *
 * session JSONL 记的是已经发生的事实，它能重放出历史，但重放不出"这个回合还没跑完"。
 * 之前一个回合被异常打断（进程退出、断网、Ctrl+C）就整个作废，哪怕前面 20 步的工具调用
 * 都成功了 —— 那些 token 全部白烧。
 *
 * 循环拿回自己手里之后，步与步之间有了落盘的位置。这里存的就是每步结束时的完整 context：
 * 下次启动发现它还在，就能从最后一个完成的步继续，而不是从头再来。
 *
 * 工具步之间保存实际已用步数；blocked 或可恢复的 incomplete 终态用 0 保存，表示只有用户
 * 显式恢复请求后才开启一个新预算窗口。完成、显式取消会清掉；关闭暂停和可恢复失败保留，新根输入替换旧断点。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../agent/core/types.js";
import type { RuntimeHighWater } from "./runtimeEvent.js";
import { agentDir, ensureAgentDirs } from "./store.js";

const turnStateVersion = 4;

export interface InterruptedTurn {
  sessionId: string;
  /** 同一个用户任务及其所有 continuation 共用的身份。旧断点可能没有该字段。 */
  turnId?: string;
  /** 触发这个回合的用户输入，用于向用户描述要续跑的是什么。 */
  prompt: string;
  /** 最后一个完成的步结束时的完整 context。 */
  systemPrompt?: string;
  messages: AgentMessage[];
  completedSteps: number;
  /** 工具执行预算快照；仅用于在途回合恢复时继续计算工具额度。 */
  facts?: unknown;
  /** blocked / incomplete 终态的恢复边界；普通工具步断点没有该字段。 */
  terminal?: InterruptedTurnTerminal;
  /** 同一 Turn 续跑前已经发生的终态；新预算窗口不能覆盖原终态。 */
  previousTerminals?: InterruptedTurnTerminal[];
  /** 最后一个已写入 session JSONL 的 runtime event 高水位。 */
  runtimeHighWater?: RuntimeHighWater;
  updatedAt: string;
}

export interface InterruptedTurnTerminal {
  status: "blocked" | "incomplete";
  stopReason: string;
  summary: string;
  blockedReason?: string;
  requiredAction?: string;
}

export class TurnStore {
  constructor(private readonly persistenceRoot: string, private readonly sessionId: string) {}

  async save(
    prompt: string,
    systemPrompt: string | undefined,
    messages: readonly AgentMessage[],
    completedSteps: number,
    facts?: unknown,
    terminal?: InterruptedTurnTerminal,
    previousTerminals?: readonly InterruptedTurnTerminal[],
    runtimeHighWater?: RuntimeHighWater
  ): Promise<void> {
    await ensureAgentDirs(this.persistenceRoot);
    const payload: InterruptedTurn = {
      sessionId: this.sessionId,
      turnId: runtimeHighWater?.turnId,
      prompt,
      systemPrompt,
      messages: [...messages],
      completedSteps,
      facts,
      terminal,
      previousTerminals: previousTerminals ? [...previousTerminals] : undefined,
      runtimeHighWater,
      updatedAt: new Date().toISOString()
    };
    const target = this.filePath();
    // 临时名带随机成分：并发 save 共用固定名会互相截断对方的临时文件。
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: turnStateVersion, turn: payload })}\n`, { encoding: "utf8", mode: 0o600 });
      const handle = await fs.open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      // rename 只保证可见性原子切换；同步目录后才确认新断点已提交。
      const directory = await fs.open(path.dirname(target), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async load(): Promise<InterruptedTurn | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      const version = (parsed as { version?: unknown }).version;
      if (version !== turnStateVersion && version !== 3 && version !== 2) throw new Error("Unsupported checkpoint version.");
      const turn = (parsed as { turn?: unknown }).turn;
      if (!isInterruptedTurn(turn) || turn.sessionId !== this.sessionId) throw new Error("Invalid checkpoint contents or session identity.");
      return turn;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // 损坏和读失败不能冒充“没有中断任务”，否则用户会误以为状态已丢失或任务已结束。
      throw new Error(`无法读取回合检查点 ${this.sessionId}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath(), { force: true });
  }

  private filePath(): string {
    return path.join(agentDir(this.persistenceRoot), "turns", `${this.sessionId}.json`);
  }
}

/** 删除会话对应的在途回合旁路状态，供统一 session 生命周期清理使用。 */
export async function deleteInterruptedTurn(persistenceRoot: string, sessionId: string): Promise<void> {
  await new TurnStore(persistenceRoot, sessionId).clear();
}

function isInterruptedTurn(value: unknown): value is InterruptedTurn {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurn>;
  return typeof candidate.sessionId === "string"
    && (candidate.turnId === undefined || typeof candidate.turnId === "string" && candidate.turnId.length > 0)
    && typeof candidate.prompt === "string"
    && (candidate.systemPrompt === undefined || typeof candidate.systemPrompt === "string")
    && Array.isArray(candidate.messages)
    && candidate.messages.length > 0
    && candidate.messages.every(isAgentMessage)
    && Number.isSafeInteger(candidate.completedSteps)
    && (candidate.completedSteps ?? -1) >= 0
    && (candidate.terminal === undefined || isInterruptedTurnTerminal(candidate.terminal))
    && (candidate.previousTerminals === undefined
      || Array.isArray(candidate.previousTerminals)
      && candidate.previousTerminals.every(isInterruptedTurnTerminal))
    && (candidate.runtimeHighWater === undefined || isRuntimeHighWater(candidate.runtimeHighWater))
    && typeof candidate.updatedAt === "string";
}

function isRuntimeHighWater(value: unknown): value is RuntimeHighWater {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<RuntimeHighWater>;
  return typeof candidate.eventId === "string"
    && candidate.eventId.length > 0
    && Number.isSafeInteger(candidate.eventSeq)
    && (candidate.eventSeq ?? 0) > 0
    && (candidate.runId === undefined || typeof candidate.runId === "string" && candidate.runId.length > 0)
    && (candidate.turnId === undefined || typeof candidate.turnId === "string" && candidate.turnId.length > 0);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") {
    return typeof message.content === "string"
      || Array.isArray(message.content) && message.content.every(isUserContent);
  }
  if (message.role === "assistant") {
    return Array.isArray(message.content) && message.content.every((part) => {
      if (typeof part !== "object" || part === null) return false;
      const content = part as Record<string, unknown>;
      if (content.type === "text" || content.type === "reasoning") return typeof content.text === "string";
      return content.type === "toolCall"
        && typeof content.id === "string"
        && typeof content.name === "string"
        && typeof content.arguments === "object"
        && content.arguments !== null
        && !Array.isArray(content.arguments);
    });
  }
  return message.role === "toolResult"
    && typeof message.toolCallId === "string"
    && typeof message.toolName === "string"
    && Array.isArray(message.content)
    && message.content.every(isToolResultContent);
}

function isUserContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const content = value as Record<string, unknown>;
  if (content.type === "text") return typeof content.text === "string";
  return (content.type === "image" || content.type === "audio")
    && typeof content.data === "string"
    && typeof content.mimeType === "string";
}

function isToolResultContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const content = value as Record<string, unknown>;
  if (content.type === "text") return typeof content.text === "string";
  return content.type === "image"
    && typeof content.data === "string"
    && typeof content.mimeType === "string";
}

function isInterruptedTurnTerminal(value: unknown): value is InterruptedTurnTerminal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurnTerminal>;
  return (candidate.status === "blocked" || candidate.status === "incomplete")
    && typeof candidate.stopReason === "string"
    && Boolean(candidate.stopReason)
    && typeof candidate.summary === "string"
    && Boolean(candidate.summary)
    && (candidate.blockedReason === undefined || typeof candidate.blockedReason === "string")
    && (candidate.requiredAction === undefined || typeof candidate.requiredAction === "string");
}
