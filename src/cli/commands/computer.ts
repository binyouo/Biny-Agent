import type { Command } from "commander";
import { ComputerAppApprovals } from "../../computer/appApprovals.js";
import { createFileConfigStore } from "../../config/store.js";

export function registerComputerCommands(program: Command): void {
  const computer = program.command("computer").description("Manage persistent desktop application approvals");
  const execute = async (operation: (policy: ComputerAppApprovals) => Promise<void>, json?: boolean): Promise<void> => {
    const policy = new ComputerAppApprovals(createFileConfigStore(process.cwd()));
    await operation(policy);
    const value = await policy.read();
    console.log(json ? JSON.stringify(value) : `Strict application approval: ${value.strictApproval ? "on" : "off"}\n${value.apps.map(app => `${app.bundleId}\t${app.appName}\t${app.approvedAt && !app.revokedAt ? "approved" : app.revokedAt ? "revoked" : "pending"}\t${app.useCount}`).join("\n")}`);
  };
  computer.command("status").option("--json", "print JSON").action((options: { json?: boolean }) => execute(async () => undefined, options.json));
  computer.command("strict").argument("<mode>", "on or off").option("--json", "print JSON").action((mode: string, options: { json?: boolean }) => {
    if (mode !== "on" && mode !== "off") throw new Error("Strict mode must be on or off.");
    return execute(async policy => await policy.setStrict(mode === "on"), options.json);
  });
  for (const operation of ["approve", "revoke"] as const) computer.command(operation).argument("<bundle-id>", "known application identifier").option("--json", "print JSON")
    .action((bundleId: string, options: { json?: boolean }) => execute(async policy => await policy[operation](bundleId), options.json));
  // 第二个出口：external MCP clients can drive the same capability over stdio.
  // stdout carries the protocol, so nothing else may be printed here.
  computer.command("mcp").description("Serve Computer Use over stdio or authenticated loopback HTTP")
    .option("--http", "serve Streamable HTTP on 127.0.0.1")
    .option("--port <n>", "HTTP port; 0 selects a free port", "0")
    .option("--token-path <path>", "create a private bearer token file (must not exist)")
    .action(async (options: { http?: boolean; port: string; tokenPath?: string }) => {
    if (options.http) {
      const { startComputerUseHttpServer } = await import("../../computer/httpMcpServer.js");
      const server = await startComputerUseHttpServer({ port: Number(options.port), tokenPath: options.tokenPath });
      console.log(JSON.stringify({ url: server.url, tokenPath: server.tokenPath }));
      const stop = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      return;
    }
    const { runComputerUseMcpServer } = await import("../../computer/mcpServer.js");
    await runComputerUseMcpServer();
  });
}
