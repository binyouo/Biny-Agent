import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { z } from "zod";
import type { AgentAssistantMessage, AgentMessage, AgentToolResult, AgentLoopTurnContext, AgentUsage, ModelRequestContext, ModelRequestMetrics, ModelRequestObserver } from "../agent/core/types.js";
import { readSessionEvents } from "../session/events.js";
import { SessionRecorder } from "../session/recorder.js";
import { replaySessionEvents } from "../session/replay.js";
import { sessionFilePath } from "../session/store.js";
import { TurnStore } from "../session/turnStore.js";
import type { RuntimeEventSink } from "../session/runtimeEvent.js";
import { createToolOperationId, type ToolRetrySafety } from "../tools/types.js";
import { SessionLeaseStore, type SessionLease } from "./SessionLease.js";
import type { TaskMessage, WorkerCommunication } from "./TaskCommunication.js";

export interface WorkerExecution {
  taskId: string;
  persistenceRoot: string;
  parentSessionId?: string;
  parentRunId?: string;
  sessionGoalId?: string;
  resume?: boolean;
  runtimeEventSink?: RuntimeEventSink;
  communication?: WorkerCommunication;
}

const usageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(), cacheWriteTokens: z.number().nonnegative().optional(),
  cacheMissTokens: z.number().nonnegative().optional()
});
const workerFactsSchema = z.object({
  version: z.literal(1), taskId: z.string(), parentSessionId: z.string().optional(),
  parentRunId: z.string().optional(), sessionGoalId: z.string().optional(),
  workspaceRoot: z.string(), policy: z.string(), startedSteps: z.number().int().nonnegative(),
  usages: z.array(usageSchema), status: z.enum(["running", "completed"]), output: z.string().optional()
}).strict();
type WorkerFacts = z.infer<typeof workerFactsSchema>;

export function workerSessionId(taskId: string): string {
  return `worker-${createHash("sha256").update(taskId).digest("hex").slice(0, 40)}`;
}

export async function readWorkerSessionCheckpoint(persistenceRoot: string, taskId: string) {
  const sessionId = workerSessionId(taskId);
  const checkpoint = await new TurnStore(persistenceRoot, sessionId).load();
  if (!checkpoint) throw new Error("Worker has no durable loop checkpoint; unsafe recovery is blocked.");
  const facts = workerFactsSchema.parse(checkpoint.facts);
  if (facts.taskId !== taskId || checkpoint.turnId !== `worker-turn:${taskId}` || checkpoint.completedSteps !== facts.startedSteps) {
    throw new Error("Worker checkpoint identity changed; unsafe recovery is blocked.");
  }
  const events = await readSessionEvents(sessionFilePath(persistenceRoot, sessionId));
  const replay = replaySessionEvents(events, { sessionId, expectedRuntimeHighWater: checkpoint.runtimeHighWater });
  if (!checkpoint.runtimeHighWater || replay.truncated || !replay.messages.length
    || replay.events.some((event) => event.type === "tool_result" && event.executionStatus === "unknown")) {
    throw new Error("Worker has an unknown tool outcome or incomplete durable history; unsafe recovery is blocked.");
  }
  if (facts.status === "completed" && (typeof facts.output !== "string" || !events.some((event) => event.type === "turn_status" && event.status === "completed"))) {
    throw new Error("Worker completion checkpoint has no durable terminal evidence.");
  }
  return { checkpoint, facts, events, replay };
}

export class WorkerSession {
  readonly sessionId: string;
  readonly recorder: SessionRecorder;
  private readonly turns: TurnStore;
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private assistant?: AgentAssistantMessage;
  private readonly callIds = new Set<string>();
  private readonly receivedMessageIds = new Set<string>();
  private readonly pendingTools = new Set<Promise<AgentToolResult>>();
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly execution: WorkerExecution,
    private readonly task: string,
    readonly systemPrompt: string,
    readonly messages: AgentMessage[],
    private facts: WorkerFacts,
    private readonly leases: SessionLeaseStore,
    private readonly lease: SessionLease
  ) {
    this.sessionId = workerSessionId(execution.taskId);
    this.recorder = new SessionRecorder(execution.persistenceRoot, this.sessionId, undefined, execution.runtimeEventSink);
    this.recorder.repairTailForAppend();
    this.recorder.setRuntimeContext({ runId: randomUUID(), turnId: `worker-turn:${execution.taskId}` });
    this.turns = new TurnStore(execution.persistenceRoot, this.sessionId);
  }

  static async open(execution: WorkerExecution, task: string, workspaceRoot: string, policy: unknown, systemPrompt: string): Promise<WorkerSession> {
    const leases = await SessionLeaseStore.open(execution.persistenceRoot);
    let session: WorkerSession | undefined;
    try {
      const sessionId = workerSessionId(execution.taskId);
      const lease = leases.acquire(sessionId);
      const turns = new TurnStore(execution.persistenceRoot, sessionId);
      const checkpoint = await turns.load();
      const facts: WorkerFacts = {
        version: 1, taskId: execution.taskId, parentSessionId: execution.parentSessionId,
        parentRunId: execution.parentRunId, sessionGoalId: execution.sessionGoalId,
        workspaceRoot: await fs.realpath(workspaceRoot), policy: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
        startedSteps: 0, usages: [], status: "running"
      };
      if (execution.resume) {
        const { checkpoint, facts: stored, events, replay } = await readWorkerSessionCheckpoint(execution.persistenceRoot, execution.taskId);
        if (stored.taskId !== facts.taskId || stored.parentSessionId !== facts.parentSessionId
          || stored.workspaceRoot !== facts.workspaceRoot || stored.policy !== facts.policy
          || checkpoint.prompt !== task || checkpoint.systemPrompt !== systemPrompt
          || checkpoint.turnId !== `worker-turn:${execution.taskId}` || checkpoint.completedSteps !== stored.startedSteps) {
          throw new Error("Worker checkpoint identity or capability policy changed; unsafe recovery is blocked.");
        }
        stored.usages = events.flatMap((event) => event.type === "agent_message" && event.message.role === "assistant" && event.message.usage ? [event.message.usage] : []);
        session = new WorkerSession(execution, task, systemPrompt, replay.messages, stored, leases, lease);
        session.recorder.restoreToolCallSequence(events.reduce((maximum, event) => event.type === "tool_call" && typeof event.sequence === "number" ? Math.max(maximum, event.sequence) : maximum, 0));
        for (const event of events) if (event.type === "tool_call" && event.toolCallId) session.callIds.add(event.toolCallId);
        for (const event of events) if (event.type === "user_message" && event.messageId) session.receivedMessageIds.add(event.messageId);
        for (const result of replay.recoveredToolResults) await session.recorder.recordAndFlush(result);
        await session.save();
      } else {
        if (checkpoint || existsSync(sessionFilePath(execution.persistenceRoot, sessionId))) throw new Error("Worker history already exists; use explicit continuation instead of replaying the task.");
        session = new WorkerSession(execution, task, systemPrompt, [{ role: "user", content: task }], facts, leases, lease);
        await session.recorder.recordAndFlush({ type: "user_message", content: task });
        await session.save();
      }
      return session;
    } catch (error) {
      if (session) await session.close();
      else leases.close();
      throw error;
    }
  }

  get startedSteps(): number { return this.facts.startedSteps; }
  get usages(): AgentUsage[] { return [...this.facts.usages]; }
  get output(): string | undefined { return this.facts.status === "completed" ? this.facts.output : undefined; }
  requestContext(): ModelRequestContext {
    return { sessionId: this.facts.parentSessionId, runId: this.facts.parentRunId, sessionGoalId: this.facts.sessionGoalId, operation: "subagent" };
  }

  async recordModelRequest(metrics: ModelRequestMetrics): Promise<void> {
    // 请求事实仍须保存，即使工具已使 Worker 隔离；失败不能抹掉已发生的模型费用。
    await this.recorder.recordAndFlush({ type: "model_request", metrics });
  }

  async replayModelRequestUsage(observer: ModelRequestObserver | undefined): Promise<void> {
    if (!observer) return;
    for (const event of await readSessionEvents(this.recorder.filePath)) {
      if (event.type === "model_request") await observer(event.metrics);
    }
  }

  setAssistant(message: AgentAssistantMessage): void { this.assistant = message; }

  async receiveMessages(messages: TaskMessage[]): Promise<AgentMessage[]> {
    const accepted: AgentMessage[] = [];
    await this.enqueue(async () => {
      for (const message of messages) {
        if (this.receivedMessageIds.has(message.id)) continue;
        const content = `Message from the parent Agent:\n${message.content}`;
        await this.recorder.recordAndFlush({ type: "user_message", messageId: message.id, content });
        this.receivedMessageIds.add(message.id);
        accepted.push({ role: "user", content });
      }
      if (accepted.length) await this.saveFromReplay();
    });
    return accepted;
  }

  async beforeRequest(maxSteps: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.facts.startedSteps >= maxSteps) throw new Error("Worker step budget is exhausted; continuation cannot reset it.");
      this.facts.startedSteps += 1;
      await this.save();
    });
  }

  executeTool(tool: string, toolCallId: string, args: unknown, retrySafety: ToolRetrySafety,
    execute: (beforeDispatch: () => Promise<void>) => Promise<AgentToolResult>): Promise<AgentToolResult> {
    if (this.closed) return Promise.reject(new Error("Worker session is closing."));
    const pending = this.performTool(tool, toolCallId, args, retrySafety, execute);
    this.pendingTools.add(pending);
    void pending.finally(() => this.pendingTools.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async performTool(tool: string, toolCallId: string, args: unknown, retrySafety: ToolRetrySafety,
    execute: (beforeDispatch: () => Promise<void>) => Promise<AgentToolResult>): Promise<AgentToolResult> {
    let sequence = 0;
    const operationId = createToolOperationId(this.sessionId, toolCallId);
    await this.enqueue(async () => {
      if (this.callIds.has(toolCallId)) throw new Error(`Worker received duplicate tool call identity: ${toolCallId}`);
      this.callIds.add(toolCallId);
      sequence = this.recorder.nextToolCallSequence();
      const reasoning = this.assistant?.content.filter((part) => part.type === "reasoning");
      await this.recorder.recordAndFlush({ type: "tool_call", tool, toolCallId, args, sequence,
        assistantContent: this.assistant?.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        reasoningBlocks: reasoning?.map((part) => ({ text: part.text, providerOptions: part.providerMetadata }))
      });
      await this.recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence, operationId, state: "not_started", retrySafety });
    });
    let dispatched = false;
    let result: AgentToolResult;
    try {
      result = await execute(async () => {
        await this.enqueue(async () => {
          await this.recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence, operationId, state: "running", retrySafety });
          dispatched = true;
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknown = dispatched && retrySafety !== "safe";
      await this.enqueue(async () => {
        await this.recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence, operationId, state: unknown ? "unknown" : "failed", retrySafety, evidence: message });
        await this.recorder.recordAndFlush({ type: "tool_result", tool, toolCallId, sequence, operationId, executionStatus: unknown ? "unknown" : "failed", result: { error: message } });
        await this.saveFromReplay();
      });
      if (unknown) {
        this.failure = new Error(`Worker tool ${tool} has an unknown side effect; unsafe continuation is blocked.`, { cause: error });
        throw this.failure;
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
    await this.enqueue(async () => {
      await this.recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence, operationId, state: result.isError ? "failed" : "succeeded", retrySafety });
      await this.recorder.recordAndFlush({ type: "tool_result", tool, toolCallId, sequence, operationId, executionStatus: result.isError ? "failed" : "succeeded", result: result.details ?? result.content });
      await this.saveFromReplay();
    });
    return result;
  }

  async persistStep(turn: AgentLoopTurnContext): Promise<void> {
    await this.enqueue(async () => {
      await this.recorder.recordAndFlush({ type: "agent_message", message: turn.message });
      for (const message of turn.toolResults) await this.recorder.recordAndFlush({ type: "agent_message", message });
      if (turn.message.usage) this.facts.usages.push(turn.message.usage);
      this.messages.splice(0, this.messages.length, ...turn.context.messages);
      await this.save();
    });
  }

  async complete(output: string): Promise<void> {
    await this.enqueue(async () => {
      await this.recorder.recordAndFlush({ type: "turn_status", status: "completed", stopReason: "completed", steps: this.facts.startedSteps, summary: output });
      this.facts.status = "completed";
      this.facts.output = output;
      await this.save();
    });
  }

  assertCanContinue(): void { if (this.failure) throw this.failure; }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      try { await Promise.allSettled([...this.pendingTools]); await this.tail; await this.recorder.close(); }
      finally { this.lease.close(); this.leases.close(); }
    })();
    return this.closePromise;
  }

  private async saveFromReplay(): Promise<void> {
    const replay = replaySessionEvents(await readSessionEvents(this.recorder.filePath), { sessionId: this.sessionId });
    this.messages.splice(0, this.messages.length, ...replay.messages);
    await this.save();
  }

  private async save(): Promise<void> {
    await this.turns.save(this.task, this.systemPrompt, this.messages, this.facts.startedSteps, this.facts, undefined, undefined, this.recorder.runtimeHighWater());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.tail.then(async () => { this.assertCanContinue(); await operation(); });
    this.tail = current.catch((error: unknown) => { this.failure ??= error instanceof Error ? error : new Error(String(error)); });
    return current;
  }
}
