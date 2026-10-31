import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const marker = process.argv[2];
if (!marker) throw new Error("A temporary marker path is required.");
const server = new Server({ name: "timeout-outcome-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: "act", inputSchema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
  annotations: { readOnlyHint: false, destructiveHint: true }
}] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const mode = request.params.arguments?.mode;
  await appendFile(marker, `called:${mode}\n`);
  if (mode === "rpc-error") throw new McpError(ErrorCode.InternalError, "Request timed out in a business diagnostic.");
  if (mode === "business-error") return { isError: true, content: [{ type: "text", text: "business rejected" }] };
  await appendFile(marker, `committed:${mode}\n`);
  if (mode === "disconnect") process.exit(0);
  if (mode === "slow") {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await appendFile(marker, "late-response-ready\n");
  }
  return { content: [{ type: "text", text: "committed" }] };
});
await server.connect(new StdioServerTransport());
