/**
 * Runtime Host 线协议的唯一实现。
 *
 * Server 和 Client 都只通过这里认识 frame 结构；JSONL 传输仍然是实现细节，不向业务层泄漏。
 */
import type { AgentRunOutcome } from "../InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../agentEvents.js";
import type {
  CapabilityInvocation,
  CapabilityRegistration
} from "../CapabilityStore.js";
import type { HostSurface } from "./types.js";

export const runtimeHostProtocolVersion = 8 as const;
export const runtimeHostEventHistoryLimit = 4_000;
export const runtimeHostMaxFrameBytes = 8 * 1024 * 1024;
/** 旧名保留：重连基准延迟。实际退避曲线（minMs/maxMs/stableConnectionMs）见 reconnect.ts。 */
export const runtimeHostReconnectDelayMs = 250;
export const runtimeHostMaxUnixSocketPathLength = 90;
export const runtimeHostStartupTimeoutMs = 8_000;
export const runtimeHostJournalFile = "runtime-host-events.jsonl";
export const runtimeHostMemoryMaintenanceIntervalMs = 60 * 1_000;
export const runtimeHostDirectoryName = "biny-runtime-host";

export const runtimeHostCapabilities = [
  "runtime.authority",
  "runtime.events.cursor",
  "runtime.run.admission",
  "runtime.run.reconnect",
  "runtime.run.continuation",
  "runtime.start-draft",
  "runtime.session-pool",
  "workspace.worktree",
  "task.ledger",
  "automation.scheduler",
  "agent.graph",
  "capability.channel",
  "personalization",
  "memory"
] as const;

/**
 * capabilities 协商：握手时，取 client 声明的 capability 与 host
 * 支持的 capability 的交集作为该连接的生效集。client 声明了 host 不认识的 capability
 * 不视为错误（前向兼容），只是不进生效集。v6 的运行快照仅携带资源就绪摘要。
 */
export function negotiateRuntimeHostCapabilities(
  clientCapabilities: readonly string[],
  hostCapabilities: readonly string[] = runtimeHostCapabilities
): string[] {
  const supported = new Set(hostCapabilities);
  const negotiated: string[] = [];
  for (const capability of clientCapabilities) {
    if (supported.has(capability) && !negotiated.includes(capability)) negotiated.push(capability);
  }
  return negotiated;
}

export interface HostHelloFrame {
  kind: "hello";
  requestId: string;
  protocolVersion: number;
  rootHash: string;
  token: string;
  configRoot: string;
  agentRoot: string;
  clientId: string;
  surface: HostSurface;
  capabilities: string[];
}

export interface HostRequestFrame {
  kind: "request";
  requestId: string;
  operation: string;
  payload: unknown;
}

export interface HostResponseFrame {
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  errorData?: unknown;
}

export interface HostEventFrame {
  kind: "event";
  hostEpoch: string;
  sequence: number;
  update: AgentRuntimeUpdate;
}

export interface HostCompletionFrame {
  kind: "completion";
  runId: string;
  outcome: AgentRunOutcome;
}

export interface HostGapFrame {
  kind: "gap";
  hostEpoch: string;
  sequence: number;
  snapshot: InteractiveRuntimeSnapshot;
  sessions?: Array<{
    sessionId: string;
    snapshot: InteractiveRuntimeSnapshot;
    primary: boolean;
    lastActiveAt: number;
  }>;
}

export interface HostCapabilityOfferFrame {
  kind: "capability-offer";
  invocation: CapabilityInvocation;
  registration: CapabilityRegistration;
}

export type HostFrame =
  | HostHelloFrame
  | HostRequestFrame
  | HostResponseFrame
  | HostEventFrame
  | HostCompletionFrame
  | HostGapFrame
  | HostCapabilityOfferFrame;

export function encodeHostFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeHostFrame(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error("Invalid Runtime Host JSON frame.");
  }
}

export function isHelloFrame(value: unknown): value is HostHelloFrame {
  const record = asRecord(value);
  return record.kind === "hello"
    && typeof record.requestId === "string"
    && typeof record.protocolVersion === "number"
    && typeof record.rootHash === "string"
    && typeof record.token === "string"
    && typeof record.configRoot === "string"
    && typeof record.agentRoot === "string"
    && typeof record.clientId === "string"
    && Array.isArray(record.capabilities)
    && record.capabilities.every((capability) => typeof capability === "string")
    && isSurface(record.surface);
}

export function isRequestFrame(value: unknown): value is HostRequestFrame {
  const record = asRecord(value);
  return record.kind === "request"
    && typeof record.requestId === "string"
    && typeof record.operation === "string";
}

export function isResponseFrame(value: unknown): value is HostResponseFrame {
  const record = asRecord(value);
  return record.kind === "response"
    && typeof record.requestId === "string"
    && typeof record.ok === "boolean";
}

export function isEventFrame(value: unknown): value is HostEventFrame {
  const record = asRecord(value);
  return record.kind === "event"
    && typeof record.hostEpoch === "string"
    && typeof record.sequence === "number"
    && isRuntimeUpdate(record.update);
}

export function isCompletionFrame(value: unknown): value is HostCompletionFrame {
  const record = asRecord(value);
  return record.kind === "completion"
    && typeof record.runId === "string"
    && isAgentRunOutcome(record.outcome);
}

export function isGapFrame(value: unknown): value is HostGapFrame {
  const record = asRecord(value);
  return record.kind === "gap"
    && typeof record.hostEpoch === "string"
    && typeof record.sequence === "number"
    && isSnapshot(record.snapshot);
}

export function isCapabilityOfferFrame(value: unknown): value is HostCapabilityOfferFrame {
  const record = asRecord(value);
  const invocation = asRecord(record.invocation);
  const registration = asRecord(record.registration);
  return record.kind === "capability-offer"
    && typeof invocation.invocationId === "string"
    && typeof registration.registrationId === "string";
}

export function isRuntimeUpdate(value: unknown): value is AgentRuntimeUpdate {
  const record = asRecord(value);
  return isSnapshot(record.snapshot);
}

export function isSnapshot(value: unknown): value is InteractiveRuntimeSnapshot {
  const record = asRecord(value);
  return typeof record.revision === "number"
    && typeof record.info === "object"
    && record.info !== null
    && typeof record.permissionMode === "string"
    && typeof record.state === "object"
    && record.state !== null;
}

export function isAgentRunOutcome(value: unknown): value is AgentRunOutcome {
  const record = asRecord(value);
  return typeof record.runId === "string"
    && typeof record.status === "string"
    && typeof record.stopReason === "string"
    && typeof record.steps === "number"
    && typeof record.durationMs === "number"
    && typeof record.output === "string";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function isSurface(value: unknown): value is HostSurface {
  return value === "desktop" || value === "tui" || value === "cli";
}
