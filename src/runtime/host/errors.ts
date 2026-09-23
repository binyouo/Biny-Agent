/** 发现阶段与握手阶段使用同一错误契约，避免第二次启动的撞锁错误掩盖版本冲突。 */
export class RuntimeHostProtocolMismatchError extends Error {
  readonly code = "protocol_version_mismatch";

  constructor(hostVersion: number, clientVersion: number, pid: number) {
    super(`Runtime Host protocol ${String(hostVersion)} is incompatible with ${String(clientVersion)}. `
      + `After confirming it has no active work, stop the old Runtime Host (PID ${String(pid)}) and retry. No replacement was started.`);
    this.name = "RuntimeHostProtocolMismatchError";
  }
}
