/**
 * Runtime Host 的请求调度边界。
 *
 * 这里仅决定请求进入哪条因果队列；具体 frame 处理和领域操作由 Server 与独立 operation 模块执行。
 */
import type { OperationLane } from "./types.js";
import { sessionIdFromFile } from "../../session/store.js";

export const memoryQueryActions = new Set(["overview", "list", "get", "search", "archive-list", "sleep-status", "sleep-runs", "sleep-preview"]);

export class OperationDispatcher {
  private readonly tails: Record<Exclude<OperationLane, "query">, Promise<void>> = {
    mutation: Promise.resolve(),
    admission: Promise.resolve(),
    control: Promise.resolve(),
    run: Promise.resolve()
  };
  private readonly runTails = new Map<string, Promise<void>>();

  dispatch<T>(lane: OperationLane, work: () => Promise<T>, key?: string): Promise<T> {
    // 查询不占因果写队列：wait-idle 或远端 MCP 读取不能挡住其他会话的快照和订阅。
    if (lane === "query") return Promise.resolve().then(work);
    if (lane !== "run" || key === undefined) {
      const result = this.tails[lane].then(work, work);
      this.tails[lane] = result.then(() => undefined, () => undefined);
      return result;
    }
    const previous = this.runTails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.runTails.set(key, tail);
    void tail.then(() => {
      if (this.runTails.get(key) === tail) this.runTails.delete(key);
    });
    return result;
  }
}

export function operationLaneKey(operation: string, payload: Record<string, unknown>): string | undefined {
  if (operationLane(operation) !== "run") return undefined;
  const session = typeof payload.sessionId === "string" && payload.sessionId.trim()
    ? payload.sessionId
    : typeof payload.session === "string" && payload.session.trim()
      ? sessionIdFromFile(payload.session)
      : undefined;
  return session !== undefined
    ? session
    : "primary";
}

export function operationLane(operation: string, payload: Record<string, unknown> = {}): OperationLane {
  if (operation === "memory" && memoryQueryActions.has(String(payload.action))) return "query";
  // Runtime 重建会替换快照并重置 revision。权限模式写入必须与重建共用 mutation 队列。
  if (operation === "agent.permission-mode" || operation === "agent.permission-command" || operation === "runtime.restart") return "mutation";
  // Admission 与取消/审批共享一条因果队列，保证 submit 后立即 cancel 时顺序稳定。
  if (
    operation === "cancel"
    || operation === "permission"
    || operation === "run.cancel"
    || operation === "run.permission"
    || operation === "submit"
    || operation === "start-interrupted"
    || operation === "run.submit"
    || operation === "run.continue"
    || operation === "queue"
    || operation === "run.queue"
    || operation === "run.queue.mutate"
  ) return "run";
  if (operation === "task.start" || operation === "task.run" || operation === "task.retry") return "admission";
  if (operation === "diary.refresh" || operation === "reflection.run" || operation === "heartbeat.run") return "admission";
  if (
    operation === "snapshot"
    || operation === "plan.list"
    || operation === "session.list"
    || operation === "worktree.list"
    || operation === "worktree.status"
    || operation === "subscribe"
    || operation === "wait-idle"
    || operation === "agent.context"
    || operation === "agent.usage"
    || operation === "agent.models"
    || operation === "agent.sessions"
    || operation === "personalization.get"
    || operation === "memory.embedding.status"
    || operation === "skills.list"
    || operation === "mcp.status"
    || operation === "mcp.details"
    || operation === "run.inspect"
    || operation === "run.list"
    || operation === "runtime.events"
    || operation === "task.get"
    || operation === "task.list"
    || operation === "task.events"
    || operation === "heartbeat.status"
    || operation === "automation.list"
    || operation === "automation.pending"
    || operation === "goal.get"
    || operation === "goal.list"
    || operation === "graph.inspect"
    || operation === "graph.events"
    || operation === "graph.list"
    || operation === "capability.list"
    || operation === "capability.get"
    || operation === "host.info"
  ) return "query";
  if (operation === "memory.sleep.cancel" || operation === "memory.embedding.cancel-download" || operation === "memory.embedding.cancel-rebuild") return "control";
  if (operation === "capability.cancel" || operation === "capability.fail" || operation === "capability.release" || operation === "capability.reject") return "control";
  if (operation === "goal.pause" || operation === "goal.cancel" || operation === "graph.pause" || operation === "graph.cancel") return "control";
  if (operation === "capability.register" || operation === "capability.replace" || operation === "capability.invoke" || operation === "capability.accept" || operation === "capability.start" || operation === "capability.result" || operation === "capability.chunk" || operation === "capability.admit" || operation === "graph.start" || operation === "graph.resume" || operation === "goal.resume") return "admission";
  return "mutation";
}
