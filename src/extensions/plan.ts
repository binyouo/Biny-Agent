/**
 * 主 Agent 的长程计划工具。
 *
 * 这里只把模型输入投影到既有 GoalGraph / TaskRun 事实链；调度、验收、审批与恢复仍由
 * Runtime Host 负责，Todo 不参与持久状态判断。
 */
import { z } from "zod";
import type { DurableTaskRunStore } from "../runtime/TaskRunStore.js";
import type { GoalGraphStore, GraphNodeInput, GraphRecord } from "../runtime/GoalGraphStore.js";
import { pendingTaskVerificationApproval, readTaskDefinition } from "../runtime/taskVerification.js";
import { ToolAccesses } from "../tools/access.js";
import type { JsonObjectSchema } from "../tools/schema.js";
import type { Tool, ToolExecutionContext } from "../tools/types.js";
import { taskVerificationSchema } from "./subagent.js";
import { planBlock, planTasksToNodes } from "../runtime/planWork.js";

const planNodeSchema = z.object({
  key: z.string().trim().min(1).max(120),
  task: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(200).optional(),
  acceptance: z.array(z.string().trim().min(1)).min(1).optional(),
  review: z.string().trim().min(1).max(8_000).optional(),
  dependencies: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  verification: taskVerificationSchema.optional()
}).strict().refine((node) => node.verification !== undefined || (node.acceptance !== undefined && node.review === undefined),
  "Without verification, a node is read-only: provide acceptance criteria and omit the verified-candidate review gate.");

const planDefinitionSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  nodes: z.array(planNodeSchema).min(2).max(20)
}).strict();
const planStartSchema = z.union([planDefinitionSchema, z.object({ graphId: z.string().min(1), revision: z.number().int().nonnegative() }).strict()]);
const planDraftSchema = planDefinitionSchema.extend({ graphId: z.string().min(1).optional(), revision: z.number().int().nonnegative().optional() })
  .refine((value) => (value.graphId === undefined) === (value.revision === undefined), "Draft updates require graphId and revision together.");

const planUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rework"), graphId: z.string().min(1), nodeId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("add"),
    graphId: z.string().trim().min(1),
    nodes: z.array(planNodeSchema).min(1).max(20)
  }).strict(),
  z.object({
    action: z.literal("replace"),
    graphId: z.string().trim().min(1),
    nodeId: z.string().trim().min(1),
    key: z.string().trim().min(1).max(120),
    task: z.string().trim().min(1).max(20_000)
  }).strict(),
  z.object({
    action: z.literal("stop"),
    graphId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(4_000).optional()
  }).strict(),
  z.object({
    action: z.literal("finish"),
    graphId: z.string().trim().min(1),
    outcome: z.enum(["completed", "failed", "blocked"]),
    summary: z.string().trim().min(1).max(8_000)
  }).strict()
]);

type PlanNodeInput = z.infer<typeof planNodeSchema>;
type PlanUpdateInput = z.infer<typeof planUpdateSchema>;

export interface PlanToolOptions {
  graphs: GoalGraphStore;
  taskRuns: DurableTaskRunStore;
  stopGraph?: (graphId: string, reason?: string) => GraphRecord;
  isPlanning?: () => boolean;
}

export function createPlanTools(options: PlanToolOptions): Tool[] {
  const inspectedRuns = new Set<string>();
  return [
    createPlanStartTool(options),
    createPlanStatusTool(options, inspectedRuns),
    createPlanUpdateTool(options, inspectedRuns),
    createPlanDraftTool(options)
  ];
}

function createPlanStartTool(options: PlanToolOptions): Tool<z.infer<typeof planStartSchema>, unknown> {
  return {
    name: "PlanStart",
    description: "Create and start a durable supervised multi-node plan bound to the current session. Use only for work that must execute now across dependent nodes or survive restarts; never call when the user asked only to see a plan.",
    promptSnippet: "Start a durable, supervised multi-node plan",
    promptGuidelines: [
      "Complete simple work in the current turn, use Task for one independently verifiable delegation, and use PlanStart only for dependent multi-node or restart-durable execution.",
      "Do not call PlanStart when the user asks only to plan, explain, review, or propose work without execution.",
      "Preserve explicit constraints. Writable nodes require deterministic verification. Omit verification only for read-only analysis with explicit acceptance criteria; never invent a command just to create a plan. PlanStart begins execution after the normal permission gate.",
      "Keep ordinary multi-step work in the current turn. Do not split implementation and its own validation into separate nodes; verification already performs the checks. Add an independent review only when it has a concrete purpose."
    ],
    parameters: {
      type: "object",
      properties: {
        graphId: { type: "string" },
        revision: { type: "integer" },
        objective: { type: "string" },
        constraints: { type: "array", items: { type: "string" } },
        nodes: {
          type: "array",
          minItems: 2,
          maxItems: 20,
          items: planNodeParameters()
        }
      },
      additionalProperties: false
    },
    schema: planStartSchema,
    source: "subagent",
    capability: "subagent.workspace",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Start durable plan", detail: "objective" in args ? args.objective : args.graphId },
        description: "Creates a supervised GoalGraph and begins serial execution.",
        approvalRule: "PlanStart",
        async execute(context): Promise<unknown> {
          const sessionId = requireSessionId(context);
          if (options.isPlanning?.()) throw new Error("Planning mode forbids starting work; ask the user to start the draft.");
          if ("graphId" in args) {
            options.graphs.startSupervisedDraft(args.graphId, sessionId, args.revision);
            options.graphs.createWake(args.graphId, "plan_started");
            return planStatus(options, args.graphId, sessionId);
          }
          const graph = options.graphs.createSupervisedGraph({
            supervisorSessionId: sessionId,
            supervisorRunId: context.runId,
            nodes: toGraphNodes(args.nodes, args.constraints),
            payload: { objective: args.objective, constraints: args.constraints ?? [] }
          });
          const started = options.graphs.startGraph(graph.graphId);
          options.graphs.createWake(graph.graphId, "plan_started");
          return planStatus(options, started.graphId, sessionId);
        }
      };
    }
  };
}

function createPlanDraftTool(options: PlanToolOptions): Tool<z.infer<typeof planDraftSchema>, unknown> {
  return {
    name: "PlanDraft", description: "Save a plan without execution. Nodes with verification can modify files and optionally have independent review; nodes without verification are read-only reports with required acceptance criteria. To revise a draft, include its graphId and revision.",
    promptGuidelines: [
      "When the user asks to plan first, save the plan with PlanDraft and keep it unstarted; PlanStart runs only after the user authorizes execution."
    ],
    source: "subagent", capability: "subagent.workspace", risk: "write", schema: planDraftSchema,
    parameters: { type: "object", properties: { objective: { type: "string" }, constraints: { type: "array", items: { type: "string" } }, nodes: { type: "array", minItems: 2, maxItems: 20, items: planNodeParameters() }, graphId: { type: "string" }, revision: { type: "integer" } }, required: ["objective", "nodes"], additionalProperties: false },
    resolveExecution(args) {
      return { accesses: ToolAccesses.none(), display: { kind: "generic", summary: "Save plan draft", detail: args.objective }, description: "Save internal plan metadata only; no Worker or workspace changes.", approvalRule: "PlanDraft", async execute(context) {
        const sessionId = requireSessionId(context);
        const nodes = toGraphNodes(args.nodes, args.constraints);
        const payload = { objective: args.objective, constraints: args.constraints ?? [] };
        const graph = args.graphId
          ? options.graphs.reviseSupervisedDraft(args.graphId, sessionId, args.revision!, nodes, payload)
          : options.graphs.createSupervisedGraph({ supervisorSessionId: sessionId, supervisorRunId: context.runId, nodes, payload });
        return planStatus(options, graph.graphId, sessionId);
      } };
    }
  };
}

function createPlanStatusTool(options: PlanToolOptions, inspectedRuns: Set<string>): Tool<{ graphId: string }, unknown> {
  return {
    name: "PlanStatus",
    description: "Read compact durable state, TaskRun identities, pending approvals, and verification evidence references for a supervised plan created by the current session. This never executes or changes work.",
    promptSnippet: "Read durable plan status and evidence",
    promptGuidelines: [
      "At the start of every plan supervision wake, call PlanStatus before PlanUpdate or reporting a result.",
      "A settled graph is only a checkpoint; inspect persisted verification evidence before finishing the user objective."
    ],
    parameters: {
      type: "object",
      properties: { graphId: { type: "string" } },
      required: ["graphId"],
      additionalProperties: false
    },
    schema: z.object({ graphId: z.string().trim().min(1) }).strict(),
    source: "subagent",
    capability: "subagent.workspace",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Read durable plan status", detail: args.graphId },
        description: "Reads a session-owned supervised GoalGraph without mutation.",
        approvalRule: "PlanStatus",
        async execute(context): Promise<unknown> {
          const sessionId = requireSessionId(context);
          const result = planStatus(options, args.graphId, sessionId);
          inspectedRuns.add(inspectedRunKey(context, args.graphId));
          return result;
        }
      };
    }
  };
}

function createPlanUpdateTool(options: PlanToolOptions, inspectedRuns: Set<string>): Tool<PlanUpdateInput, unknown> {
  return {
    name: "PlanUpdate",
    description: "Apply one bounded update to a session-owned supervised plan: add work, replace failed work without weakening its acceptance contract, stop, or finish after evidence review.",
    promptSnippet: "Update or finish a supervised durable plan",
    promptGuidelines: [
      "Call PlanStatus first in the same Agent run. Never delete history, lower verification standards, change passed evidence, or invent approval.",
      "For needs_approval, report the exact approvalId, command, cwd, and reason to the user; do not approve it yourself.",
      "Use replace only for failed, blocked, or cancelled work. At most two add or replace updates are admitted.",
      "A settled checkpoint does not prove success. Before finish completed, inspect verified-node evidence and read-only reports against their acceptance criteria. Report completion is not deterministic verification."
    ],
    parameters: planUpdateParameters(),
    schema: planUpdateSchema,
    source: "subagent",
    capability: "subagent.workspace",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: `Update durable plan: ${args.action}`, detail: args.graphId },
        description: "Mutates one supervised GoalGraph through its bounded update protocol.",
        approvalRule: "PlanUpdate",
        async execute(context): Promise<unknown> {
          const sessionId = requireSessionId(context);
          if (!inspectedRuns.has(inspectedRunKey(context, args.graphId))) {
            throw new Error("PlanStatus must be called for this graph before PlanUpdate in the same Agent run.");
          }
          if (options.isPlanning?.()) throw new Error("Planning mode only permits draft changes.");
          if (args.action === "add") {
            const graph = options.graphs.inspectGraph(args.graphId);
            const constraints = typeof graph.payload === "object" && graph.payload !== null && Array.isArray((graph.payload as { constraints?: unknown }).constraints)
              ? (graph.payload as { constraints: unknown[] }).constraints.filter((value): value is string => typeof value === "string")
              : undefined;
            const additions = toGraphNodes(args.nodes, constraints);
            const gates = new Map(graph.nodes.filter((node) => planBlock(node.intent)?.kind === "review")
              .map((node) => [planBlock(node.intent)!.taskKey, node.nodeKey]));
            options.graphs.addSupervisedNodes(args.graphId, sessionId, additions.map((node) => ({ ...node, dependencies: node.dependencies?.map((key) => gates.get(key) ?? key) })));
            options.graphs.createWake(args.graphId, "plan_updated");
          } else if (args.action === "replace") {
            options.graphs.replaceSupervisedNode(args.graphId, sessionId, args.nodeId, { nodeKey: args.key, prompt: args.task });
            options.graphs.createWake(args.graphId, "plan_replaced");
          } else if (args.action === "rework") {
            options.graphs.reworkSupervisedNode(args.graphId, sessionId, args.nodeId);
          } else if (args.action === "stop") {
            if (options.stopGraph) options.stopGraph(args.graphId, args.reason);
            else options.graphs.cancelGraph(args.graphId);
          } else {
            options.graphs.finishSupervisedGraph(args.graphId, sessionId, args.outcome, args.summary);
          }
          return planStatus(options, args.graphId, sessionId);
        }
      };
    }
  };
}

export function planStatus(options: PlanToolOptions, graphId: string, sessionId: string) {
  const graph = options.graphs.inspectGraph(graphId);
  if (graph.mode !== "supervised" || graph.supervisorSessionId !== sessionId) {
    throw new Error(`Supervised graph ${graphId} does not belong to this session.`);
  }
  const nodes = graph.nodes.map((node) => {
    const task = node.taskRunId === undefined ? undefined : options.taskRuns.get(node.taskRunId);
    const attempt = task?.attempts.at(-1);
    const approval = pendingTaskVerificationApproval(attempt?.verification);
    const approvalCheck = approval === undefined || typeof attempt?.verification !== "object" || attempt.verification === null
      ? undefined
      : (attempt.verification as { checks?: Array<{ checkId?: string; command?: string; cwd?: string; reason?: string }> }).checks
        ?.find((check) => check.checkId === approval.checkId);
    return {
      nodeId: node.nodeId,
      key: node.nodeKey,
      title: readTaskDefinition(node.intent).prompt.split(/\r?\n/u, 1)[0]!.slice(0, 200),
      block: planBlock(node.intent),
      completionBasis: planBlock(node.intent)?.kind === "report" ? "report" : planBlock(node.intent)?.kind === "review" ? "review" : "verification",
      report: node.artifact,
      status: node.status,
      dependencies: node.dependencies,
      replacesNodeId: node.replacesNodeId,
      taskRunId: node.taskRunId,
      taskStatus: task?.status,
      attemptId: attempt?.attemptId,
      approval: approval === undefined ? undefined : {
        approvalId: approval.approvalId,
        taskRunId: approval.taskRunId,
        attemptId: approval.attemptId,
        checkId: approval.checkId,
        command: approvalCheck?.command,
        cwd: approvalCheck?.cwd ?? ".",
        reason: approvalCheck?.reason ?? "Verification command requires permission."
      },
      evidence: evidenceReference(node.artifact, node.taskRunId, attempt?.attemptId)
    };
  });
  const pendingApprovals = nodes.flatMap((node) => node.approval === undefined ? [] : [{ nodeId: node.nodeId, key: node.key, ...node.approval }]);
  return {
    graphId: graph.graphId,
    objective: (graph.payload as { objective?: string })?.objective,
    status: graph.status,
    revision: graph.revision,
    checkpoint: options.graphs.supervisorCheckpoint(graph),
    replans: { used: graph.replanCount, max: graph.maxReplans },
    nodes,
    pendingApprovals,
    evidenceRunId: `graph:${graph.graphId}`
  };
}

function evidenceReference(artifact: unknown, taskRunId?: string, attemptId?: string): unknown {
  if (typeof artifact !== "object" || artifact === null) return { taskRunId, attemptId };
  const verification = (artifact as { verification?: unknown }).verification;
  if (typeof verification !== "object" || verification === null) return { taskRunId, attemptId };
  const record = verification as { status?: unknown; contractFingerprint?: unknown; artifactFingerprint?: unknown; checks?: unknown[] };
  return {
    taskRunId,
    attemptId,
    status: record.status,
    contractFingerprint: record.contractFingerprint,
    artifactFingerprint: record.artifactFingerprint,
    checkCount: record.checks?.length
  };
}

function toGraphNodes(nodes: PlanNodeInput[], constraints?: readonly string[]): GraphNodeInput[] {
  return planTasksToNodes(nodes.map((node) => ({ ...node, title: node.title ?? node.key, acceptance: node.acceptance ?? (node.verification ? [node.verification.objective] : []) })), constraints === undefined ? undefined : [...constraints]);
}

function requireSessionId(context: ToolExecutionContext): string {
  const sessionId = context.sessionId?.trim();
  if (!sessionId) throw new Error("Plan tools require a current session identity.");
  return sessionId;
}

function inspectedRunKey(context: ToolExecutionContext, graphId: string): string {
  return `${requireSessionId(context)}\0${context.runId ?? context.turnId ?? context.toolCallId}\0${graphId}`;
}

function planNodeParameters(): JsonObjectSchema {
  return {
    type: "object",
    properties: {
      key: { type: "string" },
      task: { type: "string" },
      title: { type: "string" },
      acceptance: { type: "array", minItems: 1, items: { type: "string" }, description: "Required for read-only reports. Preserve the user's success criteria." },
      review: { type: "string", description: "Optional independent read-only review of a verified candidate; requires verification. Omit when checks or supervisor inspection suffice." },
      dependencies: { type: "array", items: { type: "string" } },
      verification: {
        type: "object",
        description: "Required for writable work. Omit for read-only analysis/report nodes; they cannot write files or execute commands and are not marked verified.",
        properties: {
          objective: { type: "string" },
          context: { type: "string" },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutMs: { type: "number" },
                definitionPaths: { type: "array", items: { type: "string" } }
              },
              required: ["command"],
              additionalProperties: false
            }
          },
          artifactPaths: { type: "array", items: { type: "string" } },
          allowedRepairPaths: { type: "array", items: { type: "string" } },
          maxAttempts: { type: "number" }
        },
        required: ["objective", "checks", "artifactPaths"],
        additionalProperties: false
      }
    },
    required: ["key", "task"],
    additionalProperties: false
  };
}

function planUpdateParameters(): JsonObjectSchema {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "replace", "rework", "stop", "finish"] },
      graphId: { type: "string" },
      nodes: { type: "array", items: planNodeParameters() },
      nodeId: { type: "string" },
      key: { type: "string" },
      task: { type: "string" },
      reason: { type: "string" },
      outcome: { type: "string", enum: ["completed", "failed", "blocked"] },
      summary: { type: "string" }
    },
    required: ["action", "graphId"],
    additionalProperties: false
  };
}
