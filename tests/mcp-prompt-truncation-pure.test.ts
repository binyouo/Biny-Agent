import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read the real method, helper and budget as source; never import MCP or a host.
const file = process.env.BINY_PROMPT_SOURCE ?? path.join(process.cwd(), "src/extensions/mcp.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
const hostClass = one(source.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "McpToolHost"), "host class");
const method = one(hostClass.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "getServerPrompt"), "prompt method");
const helper = one(source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "truncateUtf8"), "UTF-8 helper");
const budget = one(source.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
  .filter(node => ts.isIdentifier(node.name) && node.name.text === "maxResourceTextBytes"), "literal budget");
assert.equal(budget.initializer?.getText(source), "64 * 1024");
assert.ok(method.body && helper.body);
const allowedCalls = new Set([
  "signal?.throwIfAborted", "this.requireServer", "waitForMcpReconnect", "this.reconnect",
  "this.requestWithCredentials", "client.getPrompt", "this.requestOptions", "truncateUtf8",
  "Math.max", "Math.min", "Math.floor", "Buffer.byteLength", "bounded", "result.messages.slice",
  "result.messages.slice(0, 32).map", "value.slice"
]);
const guard = (node: ts.Node): void => {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && !ts.isTaggedTemplateExpression(node), "no module or tagged execution boundary");
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)),
    `unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error", "only inert errors may be constructed");
  ts.forEachChild(node, guard);
};
for (const node of [method, helper, budget]) guard(node);
const extracted = `const ${budget.getText(source)};\n${helper.getText(source)}\nclass PromptProjection { ${method.getText(source)} }\nPromptProjection.prototype.getServerPrompt;`;
const compiled = ts.transpileModule(extracted, { reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Content = { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string };
interface Message { role: "user" | "assistant"; content: Content }
interface Prompt { description?: string; messages: Message[] }
interface Projection { server: string; name: string; description?: string; messages: unknown[]; truncated: boolean }
interface Signal { throwIfAborted(): void }
interface InertHost {
  requireServer(name: string): object;
  reconnect(): Promise<void>;
  requestOptions(managed: object, signal?: Signal): { signal?: Signal };
  requestWithCredentials(managed: object, request: (options: { signal?: Signal }) => Promise<Prompt>, signal?: Signal): Promise<Prompt>;
}
const project = runInNewContext(compiled.outputText, {
  Buffer: Object.freeze({ byteLength: (value: string, encoding?: BufferEncoding) => Buffer.byteLength(value, encoding) }),
  waitForMcpReconnect: () => { throw new Error("connected fixture must never reconnect"); }
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as
  (this: InertHost, server: string, name: string, args?: Record<string, string>, signal?: Signal) => Promise<Projection>;

const text = (value: string, role: Message["role"] = "user"): Message => ({ role, content: { type: "text", text: value } });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function fixture(prompt: Prompt, failure?: Error) {
  freeze(prompt);
  const calls: string[] = [];
  const args = Object.freeze({ topic: "changes" });
  let suppliedSignal: Signal | undefined;
  const managed = { status: { connected: true }, client: {
    getPrompt: async (params: { name: string; arguments: Record<string, string> }, options: { signal?: Signal }) => {
      calls.push("getPrompt");
      assert.equal(params.name, "review"); assert.equal(params.arguments, args);
      assert.equal(options.signal, suppliedSignal);
      if (failure) throw failure;
      return prompt;
    }
  } };
  const host: InertHost = {
    requireServer: name => { assert.equal(name, "fixture"); calls.push("requireServer"); return managed; },
    reconnect: async () => { throw new Error("unexpected reconnect"); },
    requestOptions: (value, signal) => { assert.equal(value, managed); return { signal }; },
    requestWithCredentials: async (value, request, signal) => { assert.equal(value, managed); return await request(host.requestOptions(value, signal)); }
  };
  return { calls, run: (signal?: Signal) => { suppliedSignal = signal; return project.call(host, "fixture", "review", args, signal); } };
}

async function check(label: string, input: Prompt, expected: Omit<Projection, "server" | "name" | "truncated">, truncated: boolean) {
  const before = JSON.stringify(input);
  const f = fixture(input);
  const result = plain(await f.run());
  assert.equal(JSON.stringify(input), before, "frozen input was not mutated");
  const { truncated: actual, ...body } = result;
  // Both original and candidate must pass every output assertion before the flag.
  assert.deepEqual(body, plain({ server: "fixture", name: "review", ...expected }), `${label}: content compatibility`);
  assert.deepEqual(f.calls, ["requireServer", "getPrompt"], `${label}: one ordinary request`);
  console.log(`content compatibility verified: ${label}`);
  assert.equal(actual, truncated, `${label}: truncation flag`);
}

test("Chinese prompt just over the byte budget reports the omitted character", async () => {
  await check("CJK residual one byte", { messages: [text("文".repeat(21_846))] },
    { messages: [text("文".repeat(21_845))] }, true);
});

test("a clipped description and later empty text cannot clear clipping", async () => {
  await check("description clipping", { description: "文".repeat(21_846), messages: [text("")] },
    { description: "文".repeat(21_845), messages: [text("")] }, true);
});

test("description, user text and embedded resource share the same budget", async () => {
  await check("embedded residual two bytes", { description: "d".repeat(65_533), messages: [text("a"),
    { role: "assistant", content: { type: "resource", resource: { uri: "fixture://notes", text: "中" } } }, text("")] },
    { description: "d".repeat(65_533), messages: [text("a"), text("", "assistant"), text("")] }, true);
});

test("non-text placeholders do not consume the residual text budget", async () => {
  const opaque: Message[] = [
    { role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
    { role: "assistant", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } },
    { role: "user", content: { type: "resource", resource: { uri: "fixture://binary", blob: "AAAA" } } },
    { role: "user", content: { type: "resource_link", uri: "fixture://link", name: "Link" } }
  ];
  const notes = opaque.map(message => ({ role: message.role, content: { type: message.content.type, note: "non-text content omitted" } }));
  await check("non-text control", { messages: opaque }, { messages: notes }, false);
  await check("late text clipped", { messages: [text("a".repeat(65_535)), ...opaque, text("中"), text("")] },
    { messages: [text("a".repeat(65_535)), ...notes, text(""), text("")] }, true);
});

test("exact occupancy, ASCII overflow and the message cap retain existing flags", async () => {
  const exact = "a".repeat(65_536);
  await check("exact occupancy", { messages: [text(exact), text("")] }, { messages: [text(exact), text("")] }, true);
  await check("ASCII overflow", { messages: [text(exact + "z")] }, { messages: [text(exact)] }, true);
  const messages = Array.from({ length: 32 }, () => text("short"));
  await check("32 messages", { messages }, { messages }, false);
  await check("33 messages", { messages: [...messages, text("omitted")] }, { messages }, true);
});

test("clipping state is per invocation and existing UTF-16 prefixes stay unchanged", async () => {
  await check("split surrogate", { description: "a".repeat(65_533), messages: [text("😀")] },
    { description: "a".repeat(65_533), messages: [text("\ud83d")] }, true);
  await check("short after clipped", { messages: [text("short", "assistant")] }, { messages: [text("short", "assistant")] }, false);
  await check("empty", { description: "", messages: [] }, { messages: [] }, false);
});

test("pre-cancellation and request rejection still reject without a projection", async () => {
  const reason = new Error("fixture cancelled");
  const cancelled = fixture({ messages: [text("unused")] });
  await assert.rejects(cancelled.run({ throwIfAborted: () => { throw reason; } }), error => error === reason);
  assert.deepEqual(cancelled.calls, []);
  const rejected = fixture({ messages: [] }, reason);
  await assert.rejects(rejected.run(), error => error === reason);
  assert.deepEqual(rejected.calls, ["requireServer", "getPrompt"]);
});
