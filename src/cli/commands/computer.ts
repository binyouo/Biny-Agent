import type { Command } from "commander";
import { ComputerAppApprovals } from "../../computer/appApprovals.js";
import { createFileConfigStore } from "../../config/store.js";
import { computerDesktopConnection } from "../../computer/desktopActivity.js";
import { computerActionSchema, computerSequenceSchema, windowObserveSchema } from "../../computer/protocol.js";
import { requestComputer } from "../../tools/computerUse.js";

export function registerComputerCommands(program: Command): void {
  const computer = program.command("computer").description("Manage persistent desktop application approvals");
  for (const [method, schema] of [["observe", windowObserveSchema], ["action", computerActionSchema], ["sequence", computerSequenceSchema]] as const) {
    computer.command(method).description("通过正在运行的 Desktop 控制器执行请求，遵守应用授权、暂停和接管")
      .argument("<request-json>", "与内置工具相同的 JSON 参数")
      .requiredOption("--session <id>", "同一操作流程使用相同编号，完成后调用 release")
      .option("--json", "输出包含画面的完整 JSON 回执")
      .action(async (request: string, options: { session: string; json?: boolean }) => {
        const args = schema.parse(JSON.parse(request));
        const endpoint = await computerDesktopConnection();
        if (!endpoint) throw new Error("computer_desktop_required: 请先启动 Desktop");
        const reply = await requestComputer(endpoint, method, { ...args, session: `cli:${options.session}` }, undefined, method !== "observe");
        console.log(options.json ? JSON.stringify(reply) : `桌面操作 ${method}\n${JSON.stringify(reply.data, null, 2)}\n画面：${reply.images.length} 张`);
        if (reply.errorCode) throw new Error(reply.errorCode);
      });
  }
  computer.command("release").description("释放此命令行流程持有的桌面控制权")
    .requiredOption("--session <id>", "操作流程编号").option("--json", "输出 JSON")
    .action(async (options: { session: string; json?: boolean }) => {
      const endpoint = await computerDesktopConnection();
      if (!endpoint) throw new Error("computer_desktop_required: 请先启动 Desktop");
      const reply = await requestComputer(endpoint, "release", { session: `cli:${options.session}` });
      console.log(options.json ? JSON.stringify(reply) : "已释放桌面控制权");
    });
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
