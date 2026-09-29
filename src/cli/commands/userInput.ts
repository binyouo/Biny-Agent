import type { Command } from "commander";
import { connectRuntimeHost } from "../../runtime/RuntimeHost.js";
import { userInputResponseSchema } from "../../runtime/userInput.js";

export function registerUserInputCommands(program: Command): void {
  const command = program.command("input").description("Read or answer a pending clarification in the current workspace");
  command.command("list").requiredOption("--session <id>", "session id").option("--json", "print JSON")
    .action(async (options: { session: string; json?: boolean }) => {
      const client = await connectRuntimeHost(process.cwd(), { surface: "cli", clientId: `input-${process.pid}` });
      if (!client) throw new Error("Runtime Host is not running.");
      try {
        const pending = await client.pendingUserInput(options.session);
        console.log(options.json ? JSON.stringify(pending) : pending.length ? pending.map((request) => [
          `${request.toolCallId} (run: ${request.runId})`,
          ...request.questions.map((question) => `${question.id}: ${question.question}\n${question.options.map((option) => `  - ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n")}`)
        ].join("\n")).join("\n\n") : "No pending questions.");
      } finally { await client.close(); }
    });
  command.command("answer <toolCallId>").requiredOption("--session <id>", "session id").requiredOption("--run <id>", "run id")
    .option("--answers <json>", "JSON array of {id, selected: string[], text?: string}")
    .option("--question <id>", "question id for a plain-text answer").option("--text <answer>", "plain-text answer to one question")
    .option("--skip", "explicitly skip these questions").option("--json", "print JSON")
    .action(async (toolCallId: string, options: { session: string; run: string; answers?: string; question?: string; text?: string; skip?: boolean; json?: boolean }) => {
      if ([options.skip, options.answers !== undefined, options.text !== undefined].filter(Boolean).length !== 1
        || Boolean(options.question) !== (options.text !== undefined)) throw new Error("Provide --answers, --question with --text, or --skip.");
      const response = userInputResponseSchema.parse(options.skip ? { status: "skipped" } : { status: "answered", answers: options.text !== undefined
        ? [{ id: options.question, selected: [], text: options.text }] : JSON.parse(options.answers!) as unknown });
      const client = await connectRuntimeHost(process.cwd(), { surface: "cli", clientId: `input-${process.pid}` });
      if (!client) throw new Error("Runtime Host is not running.");
      try {
        const result = await client.answerUserInput(options.session, options.run, toolCallId, response);
        console.log(options.json ? JSON.stringify(result) : result.response.status === "skipped" ? "Questions skipped." : "Answers submitted.");
      } finally { await client.close(); }
    });
}
