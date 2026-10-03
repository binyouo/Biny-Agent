/** 发现阶段与握手阶段使用同一错误契约，避免第二次启动的撞锁错误掩盖版本冲突。 */
export class RuntimeHostProtocolMismatchError extends Error {
  readonly code = "protocol_version_mismatch";

  constructor(hostVersion: number, clientVersion: number, pid: number) {
    super(`Runtime Host protocol ${String(hostVersion)} is incompatible with ${String(clientVersion)}. `
      + `After confirming it has no active work, stop the old Runtime Host (PID ${String(pid)}) and retry. No replacement was started.`);
    this.name = "RuntimeHostProtocolMismatchError";
  }
}

export class RuntimeHostStartupError extends Error {
  readonly code: "runtime_host_startup_timeout" | "runtime_host_startup_failed";

  constructor(readonly reason: "timeout" | "process_exit", detail: number | null, diagnostic?: {
    pid?: number;
    signal?: NodeJS.Signals;
    stderr?: string;
  }) {
    super(reason === "timeout"
      ? `Runtime Host did not become ready within ${String(detail)}ms.`
        + (diagnostic?.stderr ? `\nStartup details:\n${diagnostic.stderr}` : "")
      : `Runtime Host process${diagnostic?.pid === undefined ? "" : ` ${String(diagnostic.pid)}`} exited before attach (${diagnostic?.signal === undefined ? `code ${String(detail)}` : `signal ${diagnostic.signal}`}).`
        + (diagnostic?.stderr ? `\nStartup details:\n${diagnostic.stderr}` : ""));
    this.code = reason === "timeout" ? "runtime_host_startup_timeout" : "runtime_host_startup_failed";
    this.name = "RuntimeHostStartupError";
  }
}

export class RuntimeHostUnavailableError extends Error {
  readonly code = "runtime_host_unavailable";

  constructor(readonly pid: number) {
    super(`Runtime Host PID ${String(pid)} is alive but its endpoint is unavailable. This is a Host connection failure, not a session writer conflict. No replacement was started. Check the Host process before retrying.`);
    this.name = "RuntimeHostUnavailableError";
  }
}
