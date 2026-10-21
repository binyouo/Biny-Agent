import path from "node:path";
import type { Command } from "commander";
import { computerDesktopConnection } from "../../computer/desktopActivity.js";
import { requestBrowser } from "../../tools/browser.js";

export async function requestDesktopCommand(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const connection = await computerDesktopConnection();
  if (!connection) throw new Error("Start Biny Desktop before using this command.");
  return await requestBrowser(connection, "desktop_command", { action, ...input });
}

export function registerDesktopCommands(program: Command, session: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const project = program.command("project").description("Manage projects registered in Desktop");
  project.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => wrap(async () => {
    console.log(JSON.stringify(await requestDesktopCommand("project.list"), null, options.json ? undefined : 2));
  })());
  project.command("show").argument("<id>").option("--json", "print JSON").action((projectId: string, options: { json?: boolean }) => wrap(async () => {
    console.log(JSON.stringify(await requestDesktopCommand("project.show", { projectId }), null, options.json ? undefined : 2));
  })());
  for (const action of ["add", "create"] as const) {
    project.command(action).argument("<path>", action === "add" ? "existing directory" : "new directory")
      .option("--json", "print JSON").action((directory: string, options: { json?: boolean }) => wrap(async () => {
        console.log(JSON.stringify(await requestDesktopCommand(`project.${action}`, { path: path.resolve(directory) }), null, options.json ? undefined : 2));
      })());
  }
  project.command("rename").argument("<id>").argument("<name>").option("--json", "print JSON")
    .action((projectId: string, name: string, options: { json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand("project.rename", { projectId, name }), null, options.json ? undefined : 2));
    })());
  project.command("remove").argument("<id>", "remove the registration; keep project files")
    .option("--json", "print JSON").action((projectId: string, options: { json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand("project.remove", { projectId }), null, options.json ? undefined : 2));
    })());

  session.command("rename").argument("<id>").argument("<title>").option("--project <id>", "registered project; defaults to the current directory")
    .option("--revision <revision>", "observed session metadata revision").option("--json", "print JSON")
    .action((sessionId: string, title: string, options: { project?: string; revision?: string; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand("session.rename", { workspaceRoot, projectId: options.project, sessionId, title, revision: options.revision }), null, options.json ? undefined : 2));
    })());
  session.command("delete").argument("<id>").option("--project <id>", "registered project; defaults to the current directory")
    .option("--json", "print JSON").action((sessionId: string, options: { project?: string; json?: boolean }) => wrap(async () => {
      const result = await requestDesktopCommand("session.delete", { workspaceRoot, projectId: options.project, sessionId });
      console.log(JSON.stringify(result, null, options.json ? undefined : 2));
    })());
  for (const action of ["pin", "unpin", "archive", "unarchive", "duplicate"] as const) {
    const command = session.command(action).argument("<id>").option("--project <id>", "registered project; defaults to the current directory");
    if (action !== "duplicate") command.option("--revision <revision>", "observed metadata revision");
    command.option("--json", "print JSON")
      .action((sessionId: string, options: { project?: string; revision?: string; json?: boolean }) => wrap(async () => {
        console.log(JSON.stringify(await requestDesktopCommand(`session.${action}`, { workspaceRoot, projectId: options.project, sessionId, revision: options.revision }), null, options.json ? undefined : 2));
      })());
  }

  const preview = program.command("preview").description("Manage the current project's Desktop preview");
  for (const action of ["detect", "status", "start", "stop"] as const) {
    const command = preview.command(action).option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON");
    if (action === "start") command.option("--entry <file>", "HTML entry reported by preview detect");
    command.action((options: { project?: string; entry?: string; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand(`preview.${action}`, { workspaceRoot, projectId: options.project, entry: options.entry }), null, options.json ? undefined : 2));
    })());
  }

  const terminal = program.command("terminal").description("Use Desktop's persistent project terminals");
  for (const action of ["list", "create"] as const) {
    const command = terminal.command(action).option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON");
    if (action === "create") command.option("--name <name>", "terminal slot name", "default");
    command.action((options: { project?: string; name?: string; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand(`terminal.${action}`, { workspaceRoot, projectId: options.project, name: options.name }), null, options.json ? undefined : 2));
    })());
  }
  for (const action of ["read", "close"] as const) {
    terminal.command(action).argument("<id>").option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON")
      .action((terminalId: string, options: { project?: string; json?: boolean }) => wrap(async () => {
        console.log(JSON.stringify(await requestDesktopCommand(`terminal.${action}`, { workspaceRoot, projectId: options.project, terminalId }), null, options.json ? undefined : 2));
      })());
  }
  terminal.command("write").argument("<id>").argument("<text>", "exact input, including any newline")
    .option("--project <id>", "registered project; defaults to the current directory").option("--json", "print JSON")
    .action((terminalId: string, text: string, options: { project?: string; json?: boolean }) => wrap(async () => {
      console.log(JSON.stringify(await requestDesktopCommand("terminal.write", { workspaceRoot, projectId: options.project, terminalId, text }), null, options.json ? undefined : 2));
    })());
}
