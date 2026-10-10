/**
 * 后台 Shell 的模型工具。
 *
 * 启动职责已并入 Bash；这里仅保留读取/枚举和终止两个后续动作，底层生命周期、持久日志与
 * 进程组清理由 ManagedProcessService 统一负责。
 */
import { z } from "zod";
import { maxRegexQueryBytes } from "../search/regexMatcher.js";
import {
  ManagedProcessService,
  type HttpReadinessProbe,
  type LogReadinessProbe,
  type ManagedProcessOutput,
  type ManagedProcessReadinessProbe,
  type ManagedProcessSnapshot,
  type TcpReadinessProbe
} from "../../runtime/ManagedProcessService.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

export interface BashOutputArgs {
  /** 省略时列出当前 runtime 记录的后台 Shell。 */
  processId?: string;
  includeExited?: boolean;
  offset?: number;
  maxBytes?: number;
  fromEnd?: boolean;
}

export interface BashOutputResult {
  processes?: ManagedProcessSnapshot[];
  process?: ManagedProcessSnapshot;
  output?: ManagedProcessOutput;
}

export interface KillShellArgs {
  processId: string;
  reason?: string;
}

const commonProbeProperties = {
  timeoutMs: { type: "integer" as const, minimum: 1, maximum: 600_000, description: "Total time to wait for readiness." },
  intervalMs: { type: "integer" as const, minimum: 1, maximum: 60_000, description: "Delay between readiness attempts." }
};

const httpProbeSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<HttpReadinessProbe>;

const tcpProbeSchema = z.object({
  type: z.literal("tcp"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<TcpReadinessProbe>;

const logProbeSchema = z.object({
  type: z.literal("log"),
  pattern: z.string().min(1),
  regex: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  intervalMs: z.number().int().min(1).max(60_000).optional()
}) satisfies z.ZodType<LogReadinessProbe>;

export const managedProcessReadinessSchema = z.discriminatedUnion("type", [httpProbeSchema, tcpProbeSchema, logProbeSchema]).superRefine((probe, refinement) => {
  if (probe.type === "log" && probe.regex && Buffer.byteLength(probe.pattern, "utf8") > maxRegexQueryBytes) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: "Log readiness regex exceeds its 64 KiB UTF-8 pattern limit." });
  }
}) satisfies z.ZodType<ManagedProcessReadinessProbe>;

export const managedProcessReadinessParameters = {
  type: "object" as const,
  properties: {
    type: { type: "string" as const, enum: ["http", "tcp", "log"] },
    url: { type: "string" as const, description: "HTTP readiness URL." },
    expectedStatus: { type: "integer" as const, minimum: 100, maximum: 599, description: "Exact HTTP status required; defaults to 200." },
    host: { type: "string" as const, description: "TCP readiness host." },
    port: { type: "integer" as const, minimum: 1, maximum: 65_535, description: "TCP readiness port." },
    pattern: { type: "string" as const, description: "Literal or regular-expression log pattern. Regex patterns are limited to 65536 UTF-8 bytes; literal patterns have no regex byte limit." },
    regex: { type: "boolean" as const, description: "Interpret pattern as a regular expression." },
    ...commonProbeProperties
  },
  required: ["type"],
  additionalProperties: false,
  description: "Optional background-process readiness probe. http requires url, tcp requires host and port, log requires pattern."
};

export function createManagedProcessTools(service: ManagedProcessService): Array<Tool<unknown, unknown>> {
  return [createBashOutputTool(service), createKillShellTool(service)] as Array<Tool<unknown, unknown>>;
}

export function createBashOutputTool(service: ManagedProcessService): Tool<BashOutputArgs, BashOutputResult> {
  const schema = z.object({
    processId: z.string().uuid().optional(),
    includeExited: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1).max(256 * 1024).optional(),
    fromEnd: z.boolean().optional()
  }) satisfies z.ZodType<BashOutputArgs>;
  return {
    name: "BashOutput",
    description: "List background Bash processes, or return one process status together with a bounded page of its durable merged output log. Continue with output.nextOffset while output.hasMore is true.",
    promptSnippet: "List background Bash processes or read paginated process output",
    promptGuidelines: ["Omit processId to recover recent process IDs; use fromEnd for a tail or nextOffset for incremental reads"],
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Opaque process ID returned by a background Bash call. Omit to list processes." },
        includeExited: { type: "boolean", description: "When listing, include exited processes; defaults to true." },
        offset: { type: "integer", minimum: 0, description: "Byte offset for output pagination; defaults to 0." },
        maxBytes: { type: "integer", minimum: 1, maximum: 256 * 1024, description: "Maximum source log bytes consumed per page; defaults to 65536." },
        fromEnd: { type: "boolean", description: "Read a bounded tail instead of using offset." }
      },
      additionalProperties: false
    },
    schema,
    capability: "shell.output",
    risk: "read",
    resolveExecution(args) {
      const inspecting = args.processId !== undefined;
      if (!inspecting && (args.offset !== undefined || args.maxBytes !== undefined || args.fromEnd !== undefined)) {
        throw new Error("BashOutput pagination options require processId.");
      }
      const logPath = args.processId === undefined ? undefined : service.outputPath(args.processId);
      return {
        accesses: logPath === undefined ? ToolAccesses.none() : ToolAccesses.readFile(logPath),
        display: { kind: "generic", summary: inspecting ? `Read background Bash output ${args.processId}` : "List background Bash processes" },
        description: inspecting ? `Read background Bash output ${args.processId}` : "List background Bash processes",
        approvalRule: inspecting ? `BashOutput(${args.processId})` : "BashOutput",
        async execute({ signal }) {
          signal?.throwIfAborted();
          if (args.processId === undefined) {
            return { processes: await service.list({ includeExited: args.includeExited }), process: undefined, output: undefined };
          }
          const [process, output] = await Promise.all([
            service.status(args.processId),
            service.readOutput(args.processId, {
              offset: args.offset,
              maxBytes: args.maxBytes,
              fromEnd: args.fromEnd
            }, signal)
          ]);
          return { processes: undefined, process, output };
        }
      };
    }
  };
}

export function createKillShellTool(service: ManagedProcessService): Tool<KillShellArgs, ManagedProcessSnapshot> {
  const schema = z.object({
    processId: z.string().uuid(),
    reason: z.string().min(1).max(500).optional()
  }) satisfies z.ZodType<KillShellArgs>;
  return {
    name: "KillShell",
    description: "Stop an entire background Bash process group and return its final lifecycle state.",
    promptSnippet: "Stop a background Bash process group",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Opaque process ID returned by a background Bash call." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Optional cleanup reason." }
      },
      required: ["processId"],
      additionalProperties: false
    },
    schema,
    capability: "shell.stop",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `Stop background Bash ${args.processId}`, detail: args.reason },
        description: `Stop background Bash ${args.processId}`,
        approvalRule: `KillShell(${args.processId})`,
        async execute() {
          return await service.stop(args.processId, args.reason);
        }
      };
    }
  };
}
