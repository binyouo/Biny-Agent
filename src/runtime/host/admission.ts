/** Host 关闭开始后拒绝新工作；独立会话的正常运行不受固定数量限制。 */
export class HostDrainingError extends Error {
  readonly code = "host_draining";

  constructor() {
    super("Runtime Host is draining and no longer accepts new work.");
    this.name = "HostDrainingError";
  }
}

export class RuntimeHostAdmission {
  private draining = false;

  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  assertAdmission(): void {
    if (this.draining) throw new HostDrainingError();
  }
}

export function isRuntimeHostAdmissionOperation(operation: string): boolean {
  return operation === "session.ensure"
    || operation === "runtime.start-draft"
    || operation === "runtime.restart"
    || operation === "runtime.rotate-primary"
    || operation === "submit"
    || operation === "queue"
    || operation === "start-interrupted"
    || operation === "run.submit"
    || operation === "run.queue"
    || operation === "run.continue"
    || operation === "automation.run"
    || operation === "graph.start"
    || operation === "graph.resume"
    || operation === "goal.resume"
    || operation === "task.create"
    || operation === "task.start"
    || operation === "task.run"
    || operation === "task.approve"
    || operation === "task.resume"
    || operation === "task.retry"
    || operation === "diary.refresh"
    || operation === "reflection.run"
    || operation === "heartbeat.run"
    || operation === "capability.register"
    || operation === "capability.replace"
    || operation === "capability.admit"
    || operation === "capability.invoke"
    || operation === "capability.accept"
    || operation === "capability.start"
    || operation === "capability.result"
    || operation === "capability.chunk";
}
