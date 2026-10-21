import { InvalidArgumentError, type Command } from "commander";
import { readGlobalUsage, readSessionMessages, searchSessions } from "../../session/inspection.js";

export function registerSessionReadingCommands(program: Command, session: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const integer = (value: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new InvalidArgumentError("Expected a nonnegative integer.");
    return result;
  };
  const limit = (value: string): number => {
    const result = integer(value);
    if (result < 1 || result > 200) throw new InvalidArgumentError("Limit must be between 1 and 200.");
    return result;
  };
  session.command("messages").argument("<id>").description("Read the current message branch, including compacted messages")
    .option("--offset <number>", "first message index", integer, 0).option("--limit <number>", "maximum messages", limit, 20)
    .option("--full", "include full text and structured message parts").option("--json", "print JSON")
    .action((id: string, options: { offset: number; limit: number; full?: boolean; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await readSessionMessages(workspaceRoot, id, options), null, options.json ? undefined : 2));
    })());
  session.command("search").argument("<query>").description("Find sessions in the current workspace by title, labels or message text")
    .option("--limit <number>", "maximum sessions", limit, 20).option("--cursor <cursor>", "continue the same search")
    .option("--json", "print JSON")
    .action((query: string, options: { limit: number; cursor?: string; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await searchSessions(workspaceRoot, query, options), null, options.json ? undefined : 2));
    })());
  program.command("usage").description("Summarize persisted model usage across local workspaces").option("--json", "print JSON")
    .action((options: { json?: boolean }) => wrap(async () => {
      const result = await readGlobalUsage();
      console.log(options.json ? JSON.stringify(result) : result.report);
    })());
}
