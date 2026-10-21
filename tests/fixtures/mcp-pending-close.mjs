import { createInterface } from "node:readline";

const stage = process.argv[2];
const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === stage) {
    send({ jsonrpc: "2.0", method: "notifications/fixture/stalled", params: { requestId: message.id } });
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "pending-close-fixture", version: "1" }
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      tools: [{ name: "echo", inputSchema: { type: "object" } }]
    } });
  } else if (message.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unexpected fixture method" } });
  }
});
input.on("close", () => process.exit(0));
