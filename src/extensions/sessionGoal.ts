import { z } from "zod";
import type { SessionGoalExpectation, SessionGoalStore } from "../runtime/SessionGoalStore.js";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";

const getSchema = z.object({}).strict();
const evidenceSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  requirements: z.array(z.object({
    requirement: z.string().trim().min(1).max(4_000),
    evidence: z.string().trim().min(1).max(8_000)
  }).strict()).min(1).max(64)
}).strict();
const updateSchema = z.object({
  status: z.enum(["completed", "blocked"]), evidence: evidenceSchema
}).strict();

export function createSessionGoalTools(
  store: SessionGoalStore,
  getSessionId: () => string,
  getRequest: () => (SessionGoalExpectation & { runId: string; generation: number }) | undefined
): Tool[] {
  const get: Tool = {
    name: "GoalGet", description: "Read the durable goal of the current session, including the complete user objective, status, revision and reported usage. Takes no session or goal selector.",
    promptSnippet: "Read the current session goal", capability: "goal.read", risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false }, schema: getSchema,
    resolveExecution(input) {
      getSchema.parse(input);
      return { accesses: ToolAccesses.none(), approvalRule: "GoalGet", execute: async () => ({ goal: store.get(getSessionId()) ?? null }) };
    }
  };
  const update: Tool = {
    name: "GoalUpdate", description: "Mark the goal observed by the current model request completed or blocked. Completed requires evidence for every requirement; blocked requires a real impasse. Cannot select another session, create, edit, pause, resume, clear or change the budget of a goal.",
    promptSnippet: "Record full goal completion evidence or an actual blocker", capability: "goal.update", risk: "read",
    parameters: {
      type: "object", properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
        evidence: { type: "object", properties: {
          summary: { type: "string", minLength: 1, maxLength: 4_000 },
          requirements: { type: "array", minItems: 1, maxItems: 64, items: {
            type: "object", properties: {
              requirement: { type: "string", minLength: 1, maxLength: 4_000 },
              evidence: { type: "string", minLength: 1, maxLength: 8_000 }
            }, required: ["requirement", "evidence"], additionalProperties: false
          } }
        }, required: ["summary", "requirements"], additionalProperties: false }
      }, required: ["status", "evidence"], additionalProperties: false
    }, schema: updateSchema,
    resolveExecution(input) {
      const args = updateSchema.parse(input);
      return {
        accesses: ToolAccesses.none(), approvalRule: "GoalUpdate", retrySafety: "safe",
        display: { kind: "generic", summary: `Goal ${args.status}`, detail: args.evidence.summary },
        execute: async (context) => {
          context.signal?.throwIfAborted();
          const request = getRequest();
          if (!request || request.runId !== context.runId) {
            throw new Error("GoalUpdate does not match the objective observed by the current model request. Read the updated goal and audit it in the next model step.");
          }
          const current = store.get(getSessionId());
          if (!current || current.goalId !== request.goalId || current.generation !== request.generation || current.status !== "active") {
            throw new Error("The session goal changed after this model request began. Audit the current objective before updating its state.");
          }
          const expected = { goalId: current.goalId, revision: current.revision };
          return args.status === "completed"
            ? store.complete(getSessionId(), expected, args.evidence)
            : store.block(getSessionId(), expected, args.evidence);
        }
      };
    }
  };
  return [get, update];
}
