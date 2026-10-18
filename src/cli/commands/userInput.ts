import type { Command } from "commander";
import { connectRuntimeHost } from "../../runtime/RuntimeHost.js";
import { userInputQuestionsSchema, userInputResponseSchema, type UserInputResult } from "../../runtime/userInput.js";
import { executeSessionCommand } from "./sessionManagement.js";

export function registerUserInputCommands(program: Command, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const command = program.command("input").description("Ask, list and answer clarification questions in the current workspace")
    .addHelpText("after", "\nExamples:\n  biny input ask \"Where should the files go?\" --json\n  biny input list --session <session-id> --json\n  biny input answer <tool-call-id> --session <session-id> --run <run-id> --question answer --text \"Downloads\"\n\nAsking requires an active interactive run and its foreground command context. Answers are entered in the chat card or with input answer.");
  command.command("ask").description("Ask in the active chat and wait for an explicit answer or skip")
    .argument("[question]", "one free-text question; its question id is answer")
    .option("--input <json>", "structured questions: {questions: [{id, question, options?, multiSelect?}]}")
    .option("--session <id>", "session id; defaults to BINY_AGENT_SESSION_ID").option("--json", "print JSON")
    .addHelpText("after", '\nExamples:\n  biny input ask "What is the project name?" --json\n  biny input ask --input \'{"questions":[{"id":"place","question":"Where should the files go?","options":[{"label":"Desktop"},{"label":"Downloads"}]}]}\' --json')
    .action((question: string | undefined, options: { input?: string; session?: string; json?: boolean }) => wrap(async () => {
      if ((question !== undefined) === (options.input !== undefined)) throw new Error("Provide either a question or --input, but not both.");
      const input = userInputQuestionsSchema.parse(options.input === undefined ? { questions: [{ id: "answer", question }] } : JSON.parse(options.input));
      if (!process.env.BINY_AGENT_CONTEXT) throw new Error("Asking requires the current foreground model command context.");
      const result = await executeSessionCommand(process.cwd(), "AskUserQuestion", input, inputSessionId(options.session)) as UserInputResult;
      if (options.json) console.log(JSON.stringify(result));
      else if (result.response.status === "skipped") console.log("Questions skipped.");
      else {
        const answers = result.response.answers;
        console.log(result.questions.map(entry => {
          const answer = answers.find(value => value.id === entry.id)!;
          return `${entry.question}\n${[...answer.selected, answer.text].filter(Boolean).join(", ")}`;
        }).join("\n\n"));
      }
    })());
  command.command("list").description("List pending questions without starting a Runtime Host")
    .option("--session <id>", "session id; defaults to BINY_AGENT_SESSION_ID").option("--json", "print JSON")
    .addHelpText("after", "\nExamples:\n  biny input list --session <session-id> --json")
    .action((options: { session?: string; json?: boolean }) => wrap(async () => {
      const sessionId = inputSessionId(options.session);
      const client = await connectRuntimeHost(process.cwd(), { surface: "cli", clientId: `input-${process.pid}` });
      if (!client) throw new Error("Runtime Host is not running.");
      try {
        const pending = await client.pendingUserInput(sessionId);
        console.log(options.json ? JSON.stringify(pending) : pending.length ? pending.map((request) => [
          `${request.toolCallId} (run: ${request.runId})`,
          ...request.questions.map((question) => `${question.id}: ${question.question}\n${question.options.map((option) => `  - ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n")}`)
        ].join("\n")).join("\n\n") : "No pending questions.");
      } finally { await client.close(); }
    })());
  command.command("answer <toolCallId>").description("Answer or explicitly skip a pending question in its original run")
    .option("--session <id>", "session id; defaults to BINY_AGENT_SESSION_ID").requiredOption("--run <id>", "run id from input list")
    .option("--answers <json>", "JSON array of {id, selected: string[], text?: string}")
    .option("--question <id>", "question id for a plain-text answer").option("--text <answer>", "plain-text answer to one question")
    .option("--skip", "explicitly skip these questions").option("--json", "print JSON")
    .addHelpText("after", '\nExamples:\n  biny input answer <tool-call-id> --session <session-id> --run <run-id> --question answer --text "Downloads"\n  biny input answer <tool-call-id> --session <session-id> --run <run-id> --answers \'[{"id":"place","selected":["Downloads"]}]\' --json\n  biny input answer <tool-call-id> --session <session-id> --run <run-id> --skip')
    .action((toolCallId: string, options: { session?: string; run: string; answers?: string; question?: string; text?: string; skip?: boolean; json?: boolean }) => wrap(async () => {
      if ([options.skip, options.answers !== undefined, options.text !== undefined].filter(Boolean).length !== 1
        || Boolean(options.question) !== (options.text !== undefined)) throw new Error("Provide --answers, --question with --text, or --skip.");
      const response = userInputResponseSchema.parse(options.skip ? { status: "skipped" } : { status: "answered", answers: options.text !== undefined
        ? [{ id: options.question, selected: [], text: options.text }] : JSON.parse(options.answers!) as unknown });
      const sessionId = inputSessionId(options.session);
      const client = await connectRuntimeHost(process.cwd(), { surface: "cli", clientId: `input-${process.pid}` });
      if (!client) throw new Error("Runtime Host is not running.");
      try {
        const result = await client.answerUserInput(sessionId, options.run, toolCallId, response);
        console.log(options.json ? JSON.stringify(result) : result.response.status === "skipped" ? "Questions skipped." : "Answers submitted.");
      } finally { await client.close(); }
    })());
}

function inputSessionId(session?: string): string {
  const sessionId = session ?? process.env.BINY_AGENT_SESSION_ID;
  if (!sessionId?.trim()) throw new Error("Provide --session or run inside the current foreground model command context.");
  return sessionId;
}
