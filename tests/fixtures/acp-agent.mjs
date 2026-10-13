import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const modern = process.argv.includes("--config-options");
const configOptions = [
  { id: "llm", name: "Model", category: "model", type: "select", currentValue: "test", options: [{ value: "test", name: "Test model" }, { value: "second", name: "Second model" }] },
  { id: "execution", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] }
];
let cwd;
let pending;
let count = 0;
let cancelDrain;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (value) => send({ method: "session/update", params: { sessionId: "fixture-session", update: value } });
const finish = (id, text) => {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  send({ id, result: { stopReason: "end_turn" } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (process.env.ACP_FIXTURE_LOG) appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify(message) + "\n");
  if (message.method === "session/load") appendFileSync(path.join(message.params.cwd, "requests.jsonl"), JSON.stringify(message) + "\n");
  if (cwd) appendFileSync(path.join(cwd, "requests.jsonl"), JSON.stringify(message) + "\n");
  if (message.method === "initialize") send({ id: message.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [],
    agentInfo: { name: "fixture", version: "1" }
  } });
  else if (message.method === "session/new" || message.method === "session/load") {
    if (process.argv.includes("--auth-required")) {
      send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    if (process.argv.includes("--fail-mcp")) {
      process.stderr.write("MCP authentication failed: " + message.params.mcpServers[0].env[0].value);
      process.exit(7);
    }
    cwd = message.params.cwd;
    send({ id: message.id, result: modern ? { sessionId: "fixture-session", configOptions } : { sessionId: "fixture-session", models: {
      currentModelId: "test", availableModels: [{ modelId: "test", name: "Test model" }]
    }, modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] } } });
  } else if (message.method === "session/set_config_option") {
    configOptions.find((option) => option.id === message.params.configId).currentValue = message.params.value;
    send({ id: message.id, result: { configOptions } });
  } else if (message.method === "session/set_model" || message.method === "session/set_mode") send({ id: message.id, result: {} });
  else if (message.method === "session/prompt") {
    count++;
    const text = message.params.prompt.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (text.startsWith("cancel-drain-fixture:")) {
      pending = message.id;
      cancelDrain = text.slice("cancel-drain-fixture:".length);
      // Report an inert read already in progress; wait for session/cancel, never a sleep.
      update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read fixture", kind: "read", status: "in_progress", rawInput: { path: "fixture.txt" } });
    } else if (text.includes("refusal-fixture")) send({ id: message.id, result: { stopReason: "refusal" } });
    else if (text.includes("permission-fixture")) {
      pending = message.id;
      update({ sessionUpdate: "tool_call", toolCallId: "write-1", title: "Write", kind: "edit", status: "pending", rawInput: { path: "effect.txt" } });
      send({ id: "permission-1", method: "session/request_permission", params: {
        sessionId: "fixture-session", toolCall: { toolCallId: "write-1", title: "Write", kind: "edit" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }]
      } });
    } else if (text.includes("wait-fixture")) { pending = message.id; update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } }); }
    else if (text.includes("crash-fixture")) process.exit(7);
    else if (text.startsWith("acp-partial-output-v1:")) {
      for (const notification of JSON.parse(text.slice("acp-partial-output-v1:".length))) update(notification);
      finish(message.id, "Partial output fixture complete");
    } else finish(message.id, `Reply ${count}`);
  } else if (message.id === "permission-1") {
    const allowed = message.result?.outcome?.optionId === "yes";
    if (allowed) writeFileSync(path.join(cwd, "effect.txt"), "one external write");
    update({ sessionUpdate: "tool_call_update", toolCallId: "write-1", status: allowed ? "completed" : "failed", rawOutput: allowed ? "written" : "denied" });
    finish(pending, allowed ? "written" : "denied");
  } else if (message.method === "session/cancel" && cancelDrain) {
    send({ method: "session/update", params: { sessionId: "other-session", update: {
      sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", rawOutput: "wrong-session result"
    } } });
    if (cancelDrain !== "missing") update({ sessionUpdate: "tool_call_update", toolCallId: "read-1",
      status: cancelDrain === "failed" ? "failed" : "completed",
      rawOutput: cancelDrain === "failed" ? { error: "fixture read failed" } : "fixture contents" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stopped after reading the fixture." } });
    // Await the permission response before settling, proving cancellation still revokes authority.
    send({ id: "cancel-drain-permission", method: "session/request_permission", params: {
      sessionId: "fixture-session", toolCall: { toolCallId: "never-run", title: "Read", kind: "read" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }]
    } });
  } else if (message.id === "cancel-drain-permission" && cancelDrain) {
    if (message.result?.outcome?.outcome !== "cancelled") throw new Error("Permission survived cancellation");
    send({ id: pending, result: { stopReason: "cancelled" } });
    cancelDrain = undefined;
  } else if (message.method === "session/cancel" && !process.argv.includes("--ignore-cancel")) send({ id: pending, result: { stopReason: "cancelled" } });
  else if (message.id !== undefined) send({ id: message.id, result: {} });
}
