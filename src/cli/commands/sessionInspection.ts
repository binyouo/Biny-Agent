import type { Command } from "commander";
import { connectRuntimeHost, type RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { resolveSessionFile } from "../../session/store.js";
import { unwrapHostOperationResult } from "./sessionManagement.js";

export function registerSessionInspectionCommands(program: Command, session: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  session.command("create").description("Create a new empty session in the current workspace Host").option("--json", "print JSON")
    .action((options: { json?: boolean }) => wrap(async () => {
      const client = await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` });
      if (!client) throw new Error("The workspace Runtime Host is not running.");
      try {
        console.log(JSON.stringify(await client.ensureSession({ writeIntent: true }), null, options.json ? undefined : 2));
      } finally { await client.close(); }
    })());
  const tool = program.command("tool").description("Inspect and invoke tools through an existing session Host");
  tool.command("call").argument("<name>").argument("[args]", "JSON tool arguments", "{}")
    .option("--session <id>", "session ID; defaults to BINY_AGENT_SESSION_ID").option("--json", "print JSON")
    .action((name: string, args: string, options: { session?: string; json?: boolean }) => wrap(async () => {
      const sessionId = options.session ?? process.env.BINY_AGENT_SESSION_ID;
      if (!sessionId) throw new Error("Specify --session or BINY_AGENT_SESSION_ID.");
      let input: unknown;
      try { input = JSON.parse(args); } catch { throw new Error("Tool arguments must contain valid JSON."); }
      const client = await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` });
      if (!client) throw new Error("The workspace Runtime Host is not running.");
      try {
        await focusExistingSession(client, sessionId);
        const result = unwrapHostOperationResult(await client.sessionCommand("ToolCall", { name, input }, sessionId, process.env.BINY_AGENT_CONTEXT || undefined));
        console.log(JSON.stringify(result ?? null, null, options.json ? undefined : 2));
      } finally { await client.close(); }
    })());
  for (const action of ["usage", "compact", "tools"] as const) {
    const command = action === "tools" ? tool.command("list") : session.command(action);
    command.option("--session <id>", "session ID; defaults to BINY_AGENT_SESSION_ID").option("--json", "print JSON");
    if (action === "compact") command.option("--hint <text>", "context to preserve during compaction");
    command.action((options: { session?: string; hint?: string; json?: boolean }) => wrap(async () => {
      const sessionId = options.session ?? process.env.BINY_AGENT_SESSION_ID;
      if (!sessionId) throw new Error("Specify --session or BINY_AGENT_SESSION_ID.");
      const client = await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `cli-${process.pid}` });
      if (!client) throw new Error("The workspace Runtime Host is not running.");
      try {
        await focusExistingSession(client, sessionId);
        const result = action === "usage" ? await client.usage() : action === "tools" ? await client.listTools() : { summary: await client.compactConversation(options.hint) };
        console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      } finally { await client.close(); }
    })());
  }
}

async function focusExistingSession(client: RuntimeHostClient, sessionId: string): Promise<void> {
  if (!(await client.listRuntimeSessions()).some(session => session.sessionId === sessionId)) await resolveSessionFile(client.persistenceRoot, sessionId);
  await client.focusSession(sessionId);
}
