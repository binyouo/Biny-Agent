import type { Command } from "commander";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import { ApplicationImportService } from "../../imports/service.js";
import type { ApplicationImportHistory, ApplicationImportPreview, ApplicationImportSnapshot, ApplicationImportSource } from "../../imports/types.js";

export interface ApplicationImportsCommandOptions {
  source?: ApplicationImportSource;
  filePath?: string;
  previewId?: string;
  itemIds?: string[];
  json?: boolean;
  homeDir?: string;
  stateRoot?: string;
  configStore?: AgentConfigStore;
}
export type ApplicationImportsAction = "status" | "preview" | "run" | "sync" | "enable-sync" | "disable-sync" | "select-sync";

export async function applicationImportsCommand(workspaceRoot: string, action: ApplicationImportsAction, options: ApplicationImportsCommandOptions = {}): Promise<ApplicationImportSnapshot | ApplicationImportPreview | ApplicationImportHistory> {
  const service = new ApplicationImportService({ configStore: options.configStore ?? createFileConfigStore(workspaceRoot), homeDir: options.homeDir, stateRoot: options.stateRoot });
  let result: ApplicationImportSnapshot | ApplicationImportPreview | ApplicationImportHistory;
  if (action === "preview") {
    if (!options.source || !["claude", "codex", "chatgpt"].includes(options.source)) throw new Error("Choose claude, codex, or chatgpt as the import source.");
    if (options.source === "chatgpt" && !options.filePath) throw new Error("ChatGPT imports require an exported JSON file.");
    result = await service.preview(options.source, options.filePath);
  } else if (action === "run" || action === "select-sync") {
    if (!options.previewId || !options.itemIds) throw new Error("Use a preview ID and exact selected item IDs.");
    const selection = { previewId: options.previewId, itemIds: options.itemIds, workspaceRoot };
    result = action === "run" ? await service.run(selection) : await service.configureSyncSelection(selection);
  } else if (action === "sync") result = await service.sync();
  else if (action === "enable-sync" || action === "disable-sync") result = await service.setSyncEnabled(action === "enable-sync");
  else if (action === "status") result = await service.snapshot();
  else throw new Error("Unknown application import action.");
  if (options.json) console.log(JSON.stringify(result));
  else if ("items" in result) {
    console.log(`${result.label} preview: ${result.id}`);
    for (const item of result.items) console.log(`  ${item.id}  ${item.category}  ${item.label}\n    ${item.detail}`);
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  } else if ("results" in result) {
    console.log(`${result.label}: ${result.workspaceRoot}`);
    for (const item of result.results) console.log(`  ${item.status}  ${item.label}${item.sessionId ? `  ${item.sessionId}` : ""}${item.detail ? `\n    ${item.detail}` : ""}`);
  } else {
    for (const source of result.sources) console.log(`${source.source}: ${source.detected ? "detected" : "choose source"}  ${source.description}`);
    console.log(`Sync: ${result.sync.enabled ? "enabled" : "disabled"}; selected sources: ${String(result.sync.selections?.length ?? 0)}`);
    for (const history of result.history) console.log(`${history.time}  ${history.label}  ${history.workspaceRoot}  ${history.results.map((item) => item.status).join(", ")}`);
    if (result.sync.lastError) console.log(result.sync.lastError);
  }
  return result;
}

export function registerApplicationImportCommands(program: Command, workspaceRoot: string): void {
  const imports = program.command("imports").description("Preview and selectively import application data");
  const execute = async (action: ApplicationImportsAction, options: ApplicationImportsCommandOptions): Promise<void> => {
    try {
      const result = await applicationImportsCommand(workspaceRoot, action, options);
      if (action === "run" && "results" in result && result.results.some(item => item.status === "failed" || item.status === "unknown")) process.exitCode = 1;
      if (action === "sync" && "sync" in result && result.sync.enabled && result.sync.lastError) process.exitCode = 1;
    }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  };
  imports.option("--json", "print JSON").action((_options: { json?: boolean }, command: Command) => execute("status", { json: command.optsWithGlobals().json === true }));
  imports.command("preview <source>").option("--file <path>", "exported ChatGPT JSON file").option("--json", "print JSON")
    .action((source: ApplicationImportSource, options: { file?: string }, command: Command) => execute("preview", { source, filePath: options.file, json: command.optsWithGlobals().json === true }));
  imports.command("run <previewId>").requiredOption("--item <ids...>", "exact IDs from a current preview").option("--json", "print JSON")
    .action((previewId: string, options: { item: string[] }, command: Command) => execute("run", { previewId, itemIds: options.item, json: command.optsWithGlobals().json === true }));
  imports.command("select-sync <previewId>").option("--item <ids...>", "replace the selected item IDs").option("--clear", "remove this source and target selection").option("--json", "print JSON")
    .action((previewId: string, options: { item?: string[]; clear?: boolean }, command: Command) => {
      if (options.clear && options.item?.length) { console.error("Use --clear or --item, not both."); process.exitCode = 1; return; }
      return execute("select-sync", { previewId, itemIds: options.clear ? [] : options.item, json: command.optsWithGlobals().json === true });
    });
  for (const action of ["sync", "enable-sync", "disable-sync"] as const) {
    imports.command(action).option("--json", "print JSON").action((_options: { json?: boolean }, command: Command) => execute(action, { json: command.optsWithGlobals().json === true }));
  }
}
