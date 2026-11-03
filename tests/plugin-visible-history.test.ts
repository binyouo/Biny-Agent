/** Exact ordinary history projection and bundled plugin; synthetic data and inert calls only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { messageText } from "../src/agent/modelMessages.js";
import type { AgentMessage } from "../src/agent/core/types.js";
import { PluginLifecycleRegistry, type PluginAfterTurnContext, type PluginTurnLifecycle, type PluginTurnMessage } from "../src/extensions/pluginLifecycle.js";

// AgentSession is source text only: this test does not load its runtime/replay dependencies.
const source = readFileSync(path.join(process.cwd(), "src/agent/AgentSession.ts"), "utf8");
const ast = ts.createSourceFile("AgentSession.ts", source, ts.ScriptTarget.Latest, true);
const mappings: string[] = [];
const nodeMaps: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === "pluginMessages"
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) mappings.push(node.right.getText(ast));
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "nodes"
    && node.initializer?.getText(ast) === "new Map(replay.messageTree.map((node) => [node.id, node]))") nodeMaps.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(mappings.length, 1, "extract the sole real afterTurn history mapping");
assert.equal(nodeMaps.length, 1, "extract the real stable-ID timestamp lookup");
const javascript = ts.transpileModule(`const project = (replay, events) => { const ${nodeMaps[0]!}; return ${mappings[0]!}; };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const project = vm.runInNewContext(`${javascript}\nproject`, { messageText, Map }) as (
  replay: { messages: AgentMessage[]; messageReferences: Array<{ id: string }>; messageTree: Array<{ id: string; eventIndex: number }> },
  events: Array<{ time: string }>
) => PluginTurnMessage[];

const time = "2026-01-01T00:00:00.000Z";
function history(messages: AgentMessage[]): PluginTurnMessage[] {
  const before = structuredClone(messages);
  const references = messages.map((_, index) => ({ id: `message-${String(index)}` }));
  const projected = project({ messages, messageReferences: references, messageTree: references.map((reference, eventIndex) => ({ ...reference, eventIndex })) }, messages.map(() => ({ time })));
  assert.deepEqual(messages, before, "projection must not mutate canonical history");
  return JSON.parse(JSON.stringify(projected)) as PluginTurnMessage[];
}
const mixedAssistant: AgentMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "SYNTHETIC_HIDDEN_THOUGHT", providerMetadata: { fixture: { signature: "synthetic-signature" } } },
    { type: "text", text: "Visible first.\n" },
    { type: "toolCall", id: "call-1", name: "Write", arguments: { path: "synthetic.txt", content: "SYNTHETIC_TOOL_ARGUMENT" } },
    { type: "text", text: "Visible second." }
  ]
};

test("mixed assistant history contributes only visible text with original identity and time", () => {
  assert.deepEqual(history([mixedAssistant]), [{ id: "message-0", role: "assistant", content: "Visible first.\nVisible second.", timestamp: time }]);
});

test("reasoning-only and tool-call-only assistants do not become phantom conversation messages", () => {
  assert.deepEqual(history([
    { role: "assistant", content: [{ type: "reasoning", text: "SYNTHETIC_HIDDEN_ONLY" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "Write", arguments: { content: "SYNTHETIC_TOOL_ONLY" } }] },
    { role: "assistant", content: [{ type: "text", text: "Final visible answer" }] }
  ]), [{ id: "message-2", role: "assistant", content: "Final visible answer", timestamp: time }]);
});

test("tool results remain excluded even when their body looks like visible text", () => {
  assert.deepEqual(history([{ role: "toolResult", toolCallId: "call-1", toolName: "Read", content: [{ type: "text", text: "SYNTHETIC_TOOL_RESULT" }] }]), []);
});

test("user text and existing multimodal placeholders keep their original representation", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "  User original\r\n😀\n" },
    { role: "user", content: [{ type: "text", text: "Look: " }, { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }, { type: "audio", data: "c3ludGhldGlj", mimeType: "audio/wav" }] }
  ];
  assert.deepEqual(history(messages).map(message => message.content), messages.map(messageText));
});

test("visible text is not heuristically stripped based on words or JSON-looking content", () => {
  const content = '  reasoning toolCall {"content":"user-visible quote"}\n漢字😀\r\n';
  assert.deepEqual(history([{ role: "assistant", content: [{ type: "text", text: content }] }]), [{ id: "message-0", role: "assistant", content, timestamp: time }]);
});

test("plain conversation stays unchanged and whitespace-only assistant messages stay omitted", () => {
  assert.deepEqual(history([
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "text", text: "Hello back" }] },
    { role: "assistant", content: [{ type: "text", text: " \n\t" }] }
  ]), [
    { id: "message-0", role: "user", content: "Hello", timestamp: time },
    { id: "message-1", role: "assistant", content: "Hello back", timestamp: time }
  ]);
});

test("identical visible answers retain distinct canonical IDs after hidden-only nodes are omitted", () => {
  assert.deepEqual(history([
    { role: "assistant", content: [{ type: "text", text: "Same answer" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "SYNTHETIC_HIDDEN_BETWEEN" }] },
    { role: "assistant", content: [{ type: "text", text: "Same answer" }] }
  ]), [
    { id: "message-0", role: "assistant", content: "Same answer", timestamp: time },
    { id: "message-2", role: "assistant", content: "Same answer", timestamp: time }
  ]);
});

interface CapturedCall { server: string; tool: string; args: Record<string, unknown> }
async function pluginHarness() {
  const registry = new PluginLifecycleRegistry();
  const moduleUrl = new URL("../plugins/nowledge-mem/index.mjs", import.meta.url).href;
  const module = await import(moduleUrl) as { default(context: { config: unknown; registerTurnLifecycle(lifecycle: PluginTurnLifecycle): void }): void };
  module.default({ config: { extensions: { mcp: { "nowledge-mem": { enabled: true } } } }, registerTurnLifecycle: lifecycle => registry.register(lifecycle) });
  const calls: CapturedCall[] = [];
  const capture = async (server: string, tool: string, args: Record<string, unknown>) => { calls.push({ server, tool, args: structuredClone(args) }); return { ok: true }; };
  const context: PluginAfterTurnContext = {
    workspaceRoot: "/synthetic-only", sessionId: "synthetic-thread", userMessage: "Hello", useMemories: false, contributeMemories: true,
    outcome: { status: "completed", stopReason: "model_stop", steps: 1, output: "Visible answer" }, messages: history([mixedAssistant])
  };
  return { registry, calls, capture, context };
}

test("bundled sync_thread payload excludes assistant reasoning and tool argument bodies", async () => {
  const { registry, calls, capture, context } = await pluginHarness();
  await registry.afterTurn(context, capture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, "sync_thread");
  assert.equal(calls[0]!.server, "nowledge-mem");
  assert.deepEqual(calls[0]!.args, { thread_id: "synthetic-thread", source: "biny", messages: [{ id: "message-0", role: "assistant", timestamp: time, content: "Visible first.\nVisible second." }] });
});

test("memory opt-out and unsuccessful turns still suppress bundled sync", async () => {
  const { registry, calls, capture, context } = await pluginHarness();
  await registry.afterTurn({ ...context, contributeMemories: false }, capture);
  await registry.afterTurn({ ...context, outcome: { ...context.outcome, status: "failed" } }, capture);
  assert.deepEqual(calls, []);
});
