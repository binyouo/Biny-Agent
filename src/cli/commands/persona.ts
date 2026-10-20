import type { Command } from "commander";
import { TelegramChannelStore, parseTelegramId } from "../../channels/telegram.js";
import { TravelStorage } from "../../agent/context/travel.js";
import { SelfieAlbum } from "../../agent/context/selfie.js";
import { imageGenerateCommand, type ImageCommandOptions, type ImageCommandStoreOptions } from "./image.js";

export interface SelfieCommandOptions extends Omit<ImageCommandOptions, "localOnly">, ImageCommandStoreOptions {
  nsfw?: boolean;
}

export async function takeSelfie(workspaceRoot: string, prompt: string, options: SelfieCommandOptions = {}): Promise<void> {
  if (options.nsfw) await assertLocalSelfieAuthorization(workspaceRoot);
  const prepared = await new SelfieAlbum().prepare(prompt);
  const { nsfw, ...imageOptions } = options;
  await imageGenerateCommand(workspaceRoot, prepared.prompt, { ...imageOptions, reference: prepared.reference, localOnly: nsfw });
}

async function assertLocalSelfieAuthorization(workspaceRoot: string): Promise<void> {
  if (!process.env.BINY_AGENT_CONTEXT) return;
  const sessionId = process.env.BINY_AGENT_SESSION_ID?.trim();
  if (!sessionId) throw new Error("Local private selfies require a verified owner Telegram session.");
  const state = await new TelegramChannelStore(workspaceRoot).read();
  const ownerId = parseTelegramId(state.ownerId);
  const authorized = ownerId !== undefined && ownerId > 0 && state.sessions[String(ownerId)] === sessionId;
  if (!authorized) throw new Error("`biny selfie take --nsfw` is available to the owner in a private Telegram session only.");
}

export function registerPersonaCommands(program: Command, workspaceRoot: string): void {
  const execute = async (operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  };
  const selfie = program.command("selfie").description("Take a selfie using approved face references");
  selfie.command("take").argument("<description...>").option("--model <model>").option("--aspect <ratio>").option("--nsfw", "Use the configured loopback-only local image model").option("--json")
    .action((description: string[], options: SelfieCommandOptions) => execute(() => takeSelfie(workspaceRoot, description.join(" "), options)));
  selfie.command("save").argument("<path>").action((file: string) => execute(async () => { console.log(await new SelfieAlbum().save(file)); }));
  for (const action of ["list", "latest", "count"] as const) selfie.command(action).action(() => execute(async () => {
    const files = await new SelfieAlbum().list();
    console.log(action === "count" ? files.length : action === "latest" ? files.at(-1) ?? "No saved selfies." : files.join("\n"));
  }));
  const travel = program.command("travel").description("Manage virtual journeys, experiences and journals");
  for (const action of ["go", "event", "mood", "advance", "home"] as const) {
    const command = travel.command(action).option("--json");
    if (["go", "event", "mood"].includes(action)) command.argument("<text...>");
    command.action((...args: unknown[]) => execute(async () => {
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join(" ") : undefined;
      console.log(JSON.stringify(await new TravelStorage().change(action, text), null, 2));
    }));
  }
  for (const action of ["status", "history"] as const) travel.command(action).option("--json").action(() => execute(async () => {
    const state = await new TravelStorage().read();
    console.log(JSON.stringify(action === "history" ? state.trips : state.current ?? { traveling: false }, null, 2));
  }));
  travel.command("journal").argument("[date]", "YYYY-MM-DD", new Date().toLocaleDateString("en-CA"))
    .option("--text <text>", "append a journal entry").action((date: string, options: { text?: string }) => execute(async () => {
      console.log(await new TravelStorage().journal(date, options.text) ?? "No journal for this date.");
    }));
}
