import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { IdentityStorage } from "../../agent/context/identityStorage.js";
import { loadConfig } from "../../config/loader.js";
import { createSubagentDefinition, deleteSubagentDefinition, findSubagentDefinition, loadSubagentDefinitions } from "../../extensions/agents.js";

export function registerDocumentCommands(program: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const user = program.command("user").description("Read and update persistent user information");
  user.command("show").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(async () => {
    const document = (await new IdentityStorage().overview()).documents.user;
    console.log(options.json ? JSON.stringify(document ?? null) : document?.content ?? "No user information saved.");
  })());
  user.command("set").argument("<content>", "user information Markdown").option("--json", "print JSON")
    .action((content: string, options: { json?: boolean }) => wrap(async () => {
      const storage = new IdentityStorage();
      const previous = await storage.overview();
      const saved = await storage.saveDocument("user", content, previous.revision);
      console.log(options.json ? JSON.stringify(saved.documents.user) : saved.documents.user!.content);
    })());

  const agent = program.command("agent").description("Manage named subagent definitions");
  agent.command("create").argument("<name>").requiredOption("--file <path>", "Markdown agent definition with frontmatter")
    .option("--global", "save a global definition instead of a project definition").option("--json", "print JSON")
    .action((name: string, options: { file: string; global?: boolean; json?: boolean }) => wrap(async () => {
      const config = await loadConfig(workspaceRoot);
      const definition = await createSubagentDefinition({ workspaceRoot, projectPaths: config.extensions.subagent.agentPaths }, name, await readFile(options.file, "utf8"), options.global ? "global" : "project");
      console.log(options.json ? JSON.stringify(definition) : definition.path);
    })());
  agent.command("delete").argument("<name>").description("Delete the selected definition; a project override takes precedence")
    .option("--global", "delete the global definition even when a project override exists").option("--json", "print JSON")
    .action((name: string, options: { global?: boolean; json?: boolean }) => wrap(async () => {
      const config = await loadConfig(workspaceRoot);
      const definition = await deleteSubagentDefinition({ workspaceRoot, projectPaths: config.extensions.subagent.agentPaths }, name, options.global);
      console.log(options.json ? JSON.stringify({ deleted: definition.name, scope: definition.scope, path: definition.path }) : `Deleted ${definition.path}`);
    })());
  agent.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(async () => {
    const config = await loadConfig(workspaceRoot);
    const agents = await loadSubagentDefinitions({ workspaceRoot, projectPaths: config.extensions.subagent.agentPaths });
    const metadata = agents.map(({ name, description, scope, path, runtime, model }) => ({ name, description, scope, path, runtime, model }));
    console.log(options.json ? JSON.stringify({ agents: metadata }) : metadata.map(item => `${item.name}\t${item.scope}\t${item.description}`).join("\n"));
  })());
  agent.command("show").argument("<name>").option("--json", "print JSON").action((name: string, options: { json?: boolean }) => wrap(async () => {
    const config = await loadConfig(workspaceRoot);
    const agents = await loadSubagentDefinitions({ workspaceRoot, projectPaths: config.extensions.subagent.agentPaths });
    const definition = findSubagentDefinition(agents, name);
    if (!definition) throw new Error(`Unknown agent: ${name}`);
    console.log(options.json ? JSON.stringify(definition) : definition.prompt);
  })());
}
