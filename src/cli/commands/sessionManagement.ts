import { planCommandSchemas } from "../../extensions/plan.js";
import type { Command } from "commander";
import { connectOrSpawnRuntimeHost, connectRuntimeHost } from "../../runtime/RuntimeHost.js";
import { resolveSessionFile, sessionIdFromFile } from "../../session/store.js";
export function unwrapHostOperationResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || typeof (value as { accepted?: unknown }).accepted !== "boolean") return value;
  const result = value as { accepted: boolean; result?: unknown; reason?: string };
  if (!result.accepted) throw new Error(result.reason ?? "Runtime operation was rejected.");
  return result.result;
}

export async function executeSessionCommand(workspaceRoot: string, command: string, input: unknown, session?: string, revision?: number): Promise<unknown> {
  const scope = process.env.BINY_AGENT_CONTEXT || undefined;
  const sessionId = session ?? process.env.BINY_AGENT_SESSION_ID ?? sessionIdFromFile(await resolveSessionFile(workspaceRoot, "latest"));
  const options = { surface: "cli" as const, clientId: `cli-${process.pid}` };
  const client = scope
    ? await connectRuntimeHost(workspaceRoot, options)
    : await connectOrSpawnRuntimeHost(workspaceRoot, { ...options, workspaceRoot, resumeInterrupted: false });
  if (!client) throw new Error("The owning Runtime Host is unavailable; the foreground command context cannot be recreated.");
  try { return unwrapHostOperationResult(await client.sessionCommand(command, input, sessionId, scope, revision)); }
  finally { await client.close(); }
}

export function registerSessionManagementCommands(program: Command, goal: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  goal.command("update").description("Record completion or a real blocker for the goal observed by the current model request")
    .requiredOption("--input <json>", "JSON: {status: completed|blocked, evidence: {summary, requirements: [{requirement, evidence}]}}")
    .option("--session <id>", "defaults to the current foreground session").option("--json", "print JSON")
    .action((options: { input: string; session?: string; json?: boolean }) => wrap(async () => {
      const result = await executeSessionCommand(workspaceRoot, "GoalUpdate", JSON.parse(options.input), options.session);
      console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    })());
  const plan = program.command("plan").description("Draft, start, inspect and supervise durable session plans");
  plan.command("schema").argument("<action>", "draft, start or update").option("--json", "print JSON")
    .action((action: string) => {
      if (!Object.hasOwn(planCommandSchemas, action)) throw new Error("Plan schema action must be draft, start or update.");
      console.log(JSON.stringify(planCommandSchemas[action as keyof typeof planCommandSchemas], null, 2));
    });
  for (const [action, command] of [["draft", "PlanDraft"], ["start", "PlanStart"], ["update", "PlanUpdate"]] as const) {
    plan.command(action).requiredOption("--input <json>", action === "start" ? "plan definition or {graphId, revision}" : action === "draft" ? "plan definition: {objective, nodes, constraints?, graphId?, revision?}" : "{graphId, action: add|replace|rework|stop|finish, ...action fields}")
      .option("--revision <number>", "observed plan revision; required for manual updates", value => {
        const revision = Number(value);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Plan revision must be a nonnegative safe integer.");
        return revision;
      })
      .option("--session <id>", "defaults to the current foreground session or latest session").option("--json", "print JSON")
      .action((options: { input: string; revision?: number; session?: string; json?: boolean }) => wrap(async () => {
        const result = await executeSessionCommand(workspaceRoot, command, JSON.parse(options.input), options.session, options.revision);
        console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      })());
  }
  plan.command("status").argument("<graph-id>").option("--session <id>", "current foreground session or latest session").option("--json", "print JSON")
    .action((graphId: string, options: { session?: string; json?: boolean }) => wrap(async () => {
      const result = await executeSessionCommand(workspaceRoot, "PlanStatus", { graphId }, options.session);
      console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    })());
}
