import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "../utils/secrets.js";
import { isTaskRunTerminal, type DurableTaskRunStore, type TaskRunWithAttempts } from "./TaskRunStore.js";

const messageSchema = z.object({
  id: z.string(), direction: z.enum(["parent", "worker"]), content: z.string(), createdAt: z.string(),
  delivered: z.boolean().optional()
}).strict();
const mailboxSchema = z.object({ messages: z.array(messageSchema), inputClosed: z.boolean() }).strict();
export type TaskMessage = z.infer<typeof messageSchema>;

export interface WorkerCommunication {
  pending(): TaskMessage[];
  delivered(ids: string[]): void;
  seal(): boolean;
  report(content: string, id: string): TaskMessage;
}

/** 消息复用 Attempt 的 authority 事务；子 Session 提交接收事实后才确认送达。 */
export class TaskCommunication {
  private readonly listeners = new Set<(taskRunId: string) => void>();
  private closed = false;

  constructor(private readonly tasks: DurableTaskRunStore, private readonly sessionId: string) {}

  read(taskRunId: string): TaskRunWithAttempts {
    const task = this.tasks.get(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    if (task.sessionId !== this.sessionId) throw new Error(`TaskRun ${taskRunId} belongs to another session.`);
    return task;
  }

  send(taskRunId: string, content: string, id: string = randomUUID()): TaskMessage {
    const task = this.read(taskRunId);
    const definition = task.task as { communication?: unknown } | undefined;
    const checkpoint = artifacts(task).workerExecution as { communication?: unknown } | undefined;
    if (definition?.communication !== true && checkpoint?.communication !== true) {
      throw new Error("Worker has no communication admission; start a new bounded task.");
    }
    return this.append(task, "parent", content, id);
  }

  messages(taskRunId: string): TaskMessage[] { return mailbox(this.read(taskRunId)).messages; }

  worker(taskRunId: string, attemptId: string): WorkerCommunication {
    const current = (): TaskRunWithAttempts => {
      const task = this.read(taskRunId);
      if (task.attempts.at(-1)?.attemptId !== attemptId) throw new Error("Worker communication belongs to a stale attempt.");
      return task;
    };
    return {
      pending: () => mailbox(current()).messages.filter((message) => message.direction === "parent" && !message.delivered),
      delivered: (ids) => {
        if (!ids.length) return;
        const task = current();
        const state = mailbox(task);
        this.save(task, { ...state, messages: state.messages.map((message) => ids.includes(message.id) ? { ...message, delivered: true } : message) });
      },
      seal: () => {
        const task = current();
        const state = mailbox(task);
        if (state.messages.some((message) => message.direction === "parent" && !message.delivered)) return false;
        if (!state.inputClosed) this.save(task, { ...state, inputClosed: true });
        return true;
      },
      report: (content, id) => this.append(current(), "worker", content, `worker:${attemptId}:${id}`)
    };
  }

  notify(taskRunId: string): void { for (const listener of this.listeners) listener(taskRunId); }

  async wait(taskRunId: string, waitMs = 0, afterRevision?: number, signal?: AbortSignal): Promise<TaskRunWithAttempts> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error("Task wait must be between 0 and 60000ms.");
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) throw new Error("Invalid task revision.");
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Task communication is closed.");
    const task = this.read(taskRunId);
    const revision = afterRevision ?? task.revision;
    const ready = (): boolean => {
      const current = this.read(taskRunId);
      return current.revision > revision || isTaskRunTerminal(current.status) || ["blocked", "needs_approval"].includes(current.status);
    };
    if (waitMs === 0 || ready()) return task;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const listener = (id: string): void => {
        try { if (this.closed || (id === taskRunId && ready())) finish(); } catch (error) { finish(error); }
      };
      const abort = (): void => finish(signal?.reason ?? new Error("Task wait cancelled."));
      const timer = setTimeout(() => finish(), waitMs);
      this.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else listener(taskRunId);
    });
    return this.read(taskRunId);
  }

  close(): void { this.closed = true; this.notify(""); }

  private append(task: TaskRunWithAttempts, direction: TaskMessage["direction"], content: string, id: string): TaskMessage {
    if (this.closed) throw new Error("Task communication is closed.");
    const text = redactSecrets(content.trim());
    if (!id.trim() || id.length > 256) throw new Error("Task message identity must contain between 1 and 256 characters.");
    if (!text || text.length > 8_000) throw new Error("Task message must contain between 1 and 8000 characters.");
    const state = mailbox(task);
    const existing = state.messages.find((message) => message.id === id);
    if (existing) {
      if (existing.direction !== direction || existing.content !== text) throw new Error("Task message identity was reused with different content.");
      return existing;
    }
    if (!["queued", "running"].includes(task.status) || state.inputClosed) throw new Error("Task no longer accepts messages; start a new bounded task.");
    if (state.messages.length >= 128) throw new Error("Task message limit reached (128).");
    const message: TaskMessage = { id, direction, content: text, createdAt: new Date().toISOString() };
    this.save(task, { ...state, messages: [...state.messages, message] });
    return message;
  }

  private save(task: TaskRunWithAttempts, state: z.infer<typeof mailboxSchema>): void {
    const attempt = task.attempts.at(-1);
    if (!attempt) throw new Error("Task has no admitted Worker attempt.");
    this.tasks.transition(task.taskRunId, task.status, {
      attemptId: attempt.attemptId, artifacts: { ...artifacts(task), communication: state }
    });
    this.notify(task.taskRunId);
  }
}

function artifacts(task: TaskRunWithAttempts): Record<string, unknown> {
  const value = task.attempts.at(-1)?.artifacts;
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function mailbox(task: TaskRunWithAttempts): z.infer<typeof mailboxSchema> {
  const value = artifacts(task).communication;
  return value === undefined ? { messages: [], inputClosed: false } : mailboxSchema.parse(value);
}
