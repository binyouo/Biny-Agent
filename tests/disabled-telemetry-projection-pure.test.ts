import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute only the real thinking yield/start call and pure projection/serialization
// functions. No AgentSession imports, filesystem sink, provider, or Host is loaded.
const root = process.env.BINY_TELEMETRY_SOURCE_ROOT ?? process.cwd();
const sessionPath = process.env.BINY_TELEMETRY_SESSION_SOURCE ?? path.join(root, "src/agent/AgentSession.ts");
const baselinePath = process.env.BINY_TELEMETRY_BASELINE;
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
function functionNode(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  return one(source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
}
function checkCalls(nodes: readonly ts.Node[], source: ts.SourceFile): void {
  const calls = new Set(["recordNativeTelemetry", "systemPromptForTelemetry", "messagesForTelemetry", "stripTransientTurnContext",
    "replacePromptBlock", "safePayload", "redactSecrets", "sanitizeUsage", "sanitizeRequestMetrics", "appendSecureTelemetry", "agentDir"]);
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), "no product imports");
    if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Date", "only fixed Date may be constructed");
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) assert.ok(calls.has(expression.text), `unreviewed call: ${expression.text}`);
      else {
        assert.ok(ts.isPropertyAccessExpression(expression), "no computed or dynamic calls");
        const receiver = expression.expression;
        const member = expression.name.text;
        const name = receiver.getText(source);
        const permitted = member === "stringify" && name === "JSON"
          || member === "join" && name === "path"
          || member === "map" && ["messages", "metrics.attempts"].includes(name)
          || member === "indexOf" && name === "prompt"
          || member === "slice" && (name === "prompt" || ts.isCallExpression(receiver) && receiver.expression.getText(source) === "JSON.stringify")
          || member === "toISOString" && ts.isNewExpression(receiver) && receiver.expression.getText(source) === "Date"
          || member === "catch" && ts.isCallExpression(receiver) && receiver.expression.getText(source) === "appendSecureTelemetry"
          || member === "replace" && replaceRoot(receiver);
        assert.ok(permitted, `unreviewed member call: ${expression.getText(source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  // redactSecrets is a fixed chain of String.replace calls rooted at its value.
  const replaceRoot = (node: ts.Expression): boolean => ts.isIdentifier(node) && node.text === "value"
    || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "replace" && replaceRoot(node.expression.expression);
  nodes.forEach(visit);
}
function compile(source: string): string {
  const result = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
function producer(file: string): string {
  const source = parse(file);
  const owner = one(source.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "AgentSession"), "AgentSession");
  const method = one(owner.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === "runTurnLoop"), "runTurnLoop");
  assert.ok(method.body);
  const start = one(method.body.statements.filter(node => {
    if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression) || !ts.isCallExpression(node.expression.expression)) return false;
    const call = node.expression.expression;
    if (call.expression.getText(source) !== "recordNativeTelemetry") return false;
    const event = call.arguments[2];
    return event !== undefined && ts.isObjectLiteralExpression(event) && event.properties.some(property => ts.isPropertyAssignment(property)
      && property.name.getText(source) === "type" && ts.isStringLiteral(property.initializer) && property.initializer.text === "start");
  }), "unique top-level start telemetry call");
  const previous = method.body.statements[method.body.statements.indexOf(start) - 1];
  assert.ok(previous);
  assert.equal(previous.getText(source), 'yield { type: "status", status: "thinking" };', "retain the immediately preceding yield");
  checkCalls([previous, start], source);
  return compile(`(async function* (systemPrompt, messages, activeModelSettings) {\n${previous.getText(source)}\n${start.getText(source)}\n});`);
}
const projections = parse(path.join(root, "src/agent/prompts.ts"));
const sink = parse(path.join(root, "src/observability/telemetry.ts"));
const redaction = parse(path.join(root, "src/utils/redaction.ts"));
const markerNames = ["security", "soul", "identity", "parentThread", "activity", "dailyNotes", "crystal", "emotion"]
  .flatMap(name => [name + "PromptStart", name + "PromptEnd"]);
const markers = markerNames.map(name => one(projections.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
  && node.declarationList.declarations.length === 1 && node.declarationList.declarations[0]!.name.getText(projections) === name), name));
for (const marker of markers) assert.ok(marker.declarationList.declarations[0]!.initializer && ts.isStringLiteral(marker.declarationList.declarations[0]!.initializer!), "literal marker only");
const projectionNodes = ["messagesForTelemetry", "stripTransientTurnContext", "systemPromptForTelemetry", "replacePromptBlock"].map(name => functionNode(projections, name));
const sinkNodes = ["recordNativeTelemetry", "safePayload", "sanitizeUsage", "sanitizeRequestMetrics"].map(name => functionNode(sink, name));
const redactionNodes = [functionNode(redaction, "redactSecrets")];
checkCalls(projectionNodes, projections); checkCalls(sinkNodes, sink); checkCalls(redactionNodes, redaction);
const pureProgram = compile([
  ...markers.map(node => node.getText(projections)),
  ...projectionNodes.map(node => node.getText(projections).replace(/^export /u, "")),
  ...sinkNodes.map(node => node.getText(sink).replace(/^export /u, "")),
  ...redactionNodes.map(node => node.getText(redaction).replace(/^export /u, "")),
  "({ messagesForTelemetry, systemPromptForTelemetry, recordNativeTelemetry });"
].join("\n"));
const program = producer(sessionPath);
const baselineProgram = baselinePath === undefined ? undefined : producer(baselinePath);

interface Configuration { telemetry: { enabled: boolean; recordInputs: boolean; recordOutputs: boolean } }
interface Message { role: string; content: unknown; originalContent?: unknown; [key: string]: unknown }
interface StartEvent { type: string; provider: string; modelId: string; input?: { systemPrompt?: string; messages: Message[] } }
interface PureApi {
  messagesForTelemetry(messages: Message[]): Message[];
  systemPromptForTelemetry(prompt: string | undefined): string | undefined;
  recordNativeTelemetry(config: Configuration, workspace: string, event: StartEvent): Promise<void>;
}
type Producer = (this: object, prompt: string | undefined, messages: Message[], model: object) => AsyncGenerator<unknown, void>;
const fixedTime = "2026-10-12T00:00:00.000Z";
const config = (enabled: boolean, recordInputs: boolean): Configuration => ({ telemetry: { enabled, recordInputs, recordOutputs: false } });
const model = { model: { provider: "fixture-provider", modelId: "fixture-model" } };
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function fixture(selectedProgram = program) {
  const lines: string[] = [];
  const counts = { messages: 0, system: 0, sink: 0 };
  const events: StartEvent[] = [];
  const api = runInNewContext(pureProgram, {
    Date: class { toISOString(): string { return fixedTime; } },
    agentDir: (workspace: string) => { assert.equal(workspace, "/inert/workspace"); return "/inert/agent"; },
    path: { join: (...parts: string[]) => { assert.deepEqual(Array.from(parts), ["/inert/agent", "telemetry.jsonl"]); return "/inert/agent/telemetry.jsonl"; } },
    appendSecureTelemetry: async (file: string, line: string) => { assert.equal(file, "/inert/agent/telemetry.jsonl"); lines.push(line); }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as PureApi;
  const run = runInNewContext(selectedProgram, {
    messagesForTelemetry: (messages: Message[]) => { counts.messages += 1; return api.messagesForTelemetry(messages); },
    systemPromptForTelemetry: (prompt: string | undefined) => { counts.system += 1; return api.systemPromptForTelemetry(prompt); },
    recordNativeTelemetry: async (selected: Configuration, workspace: string, event: StartEvent) => {
      counts.sink += 1; events.push(event); await api.recordNativeTelemetry(selected, workspace, event);
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Producer;
  return { lines, counts, events, api, run };
}
const prompt = ["stable text", ...["security", "soul", "identity", "parent-thread", "activity", "daily-notes", "crystal", "emotion"]
  .map(name => `<!-- biny-${name}:start -->private ${name}<!-- biny-${name}:end -->`)].join("\n");
const messages: Message[] = [
  { role: "user", content: "transient private context", originalContent: "canonical user text" },
  { role: "assistant", content: [{ type: "text", text: "assistant text" }, { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "file.ts" } }] },
  { role: "toolResult", toolCallId: "call-1", toolName: "Read", content: [{ type: "text", text: "tool text" }] }
];
freeze(messages);
async function finish(f: ReturnType<typeof fixture>, receiver: { options: { config: Configuration; workspaceRoot: string }; activeConfig: Configuration },
  afterYield?: () => void, input = { prompt: prompt as string | undefined, messages }): Promise<void> {
  const { prompt: selectedPrompt, messages: selectedMessages } = input;
  const before = JSON.stringify(selectedMessages);
  const iteration = f.run.call(receiver, selectedPrompt, selectedMessages, model);
  assert.deepEqual(plain(await iteration.next()), { value: { type: "status", status: "thinking" }, done: false });
  assert.deepEqual(f.counts, { messages: 0, system: 0, sink: 0 }, "no projection, sink, or config snapshot before yield");
  afterYield?.();
  assert.deepEqual(plain(await iteration.next()), { value: undefined, done: true });
  assert.equal(JSON.stringify(selectedMessages), before, "original messages remain untouched");
}
function receiver(selected: Configuration, active = selected) {
  return { options: { config: selected, workspaceRoot: "/inert/workspace" }, activeConfig: active };
}
async function verifyLines(f: ReturnType<typeof fixture>, selected: Configuration, label: string, input = { prompt: prompt as string | undefined, messages }): Promise<void> {
  const { prompt: selectedPrompt, messages: selectedMessages } = input;
  // Locally the comparison executes the unchanged, independently mirrored producer.
  // CI additionally checks the full serialized line via the unchanged real sink/helpers.
  const reference = fixture(baselineProgram ?? program);
  await reference.api.recordNativeTelemetry(selected, "/inert/workspace", {
    type: "start", provider: "fixture-provider", modelId: "fixture-model",
    input: { systemPrompt: reference.api.systemPromptForTelemetry(selectedPrompt), messages: reference.api.messagesForTelemetry(selectedMessages) }
  });
  assert.deepEqual(f.lines, reference.lines, "complete telemetry lines, including omission/redaction, remain identical");
  if (baselineProgram !== undefined) {
    const baseline = fixture(baselineProgram);
    await finish(baseline, receiver(selected), undefined, input);
    assert.deepEqual(f.lines, baseline.lines, "actual baseline start expression produces the same complete lines");
  }
  assert.equal(f.counts.sink, 1, "retain the original telemetry call");
  assert.equal(f.events[0]?.type, "start"); assert.equal(f.events[0]?.provider, "fixture-provider"); assert.equal(f.events[0]?.modelId, "fixture-model");
  console.log("TELEMETRY_LINES " + JSON.stringify({ label, lines: f.lines }));
}

for (const [enabled, recordInputs] of [[false, false], [false, true], [true, false], [true, true]] as const) {
  test(`start telemetry enabled=${enabled} recordInputs=${recordInputs}`, async () => {
    const selected = config(enabled, recordInputs); const f = fixture();
    await finish(f, receiver(selected)); await verifyLines(f, selected, `${enabled}/${recordInputs}`);
    assert.deepEqual(f.counts, { messages: enabled && recordInputs ? 1 : 0, system: enabled && recordInputs ? 1 : 0, sink: 1 });
    if (enabled && recordInputs) {
      assert.deepEqual(plain(f.events[0]?.input), plain({ systemPrompt: f.api.systemPromptForTelemetry(prompt), messages: f.api.messagesForTelemetry(messages) }));
      assert.doesNotMatch(f.lines[0]!, /private|transient/u);
      assert.match(f.lines[0]!, /canonical user text/u);
    }
  });
}

test("read the live options config after the thinking yield", async () => {
  for (const [from, to] of [[config(false, false), config(true, true)], [config(true, true), config(true, false)], [config(true, true), config(false, true)]]) {
    assert.ok(from && to); const state = receiver(from); const f = fixture();
    await finish(f, state, () => { state.options.config = to; }); await verifyLines(f, to, `yield/${to.telemetry.enabled}/${to.telemetry.recordInputs}`);
    const expected = to.telemetry.enabled && to.telemetry.recordInputs ? 1 : 0;
    assert.deepEqual(f.counts, { messages: expected, system: expected, sink: 1 });
  }
});

test("the guard follows options.config even when activeConfig differs", async () => {
  for (const enabled of [true, false]) {
    const selected = config(enabled, enabled); const f = fixture();
    await finish(f, receiver(selected, config(!enabled, !enabled))); await verifyLines(f, selected, `active/${enabled}`);
    assert.deepEqual(f.counts, { messages: enabled ? 1 : 0, system: enabled ? 1 : 0, sink: 1 });
  }
});

test("successive calls observe configuration updates without caching", async () => {
  const state = receiver(config(false, false));
  const f = fixture();
  for (const selected of [config(false, false), config(true, true), config(true, false), config(true, true)]) {
    state.options.config = selected;
    f.lines.length = 0; f.events.length = 0; Object.assign(f.counts, { messages: 0, system: 0, sink: 0 });
    await finish(f, state); await verifyLines(f, selected, `next/${selected.telemetry.enabled}/${selected.telemetry.recordInputs}`);
    const expected = selected.telemetry.enabled && selected.telemetry.recordInputs ? 1 : 0;
    assert.deepEqual(f.counts, { messages: expected, system: expected, sink: 1 });
  }
});

test("enabled input preserves existing undefined, canonical multimodal, redaction and truncation behavior", async () => {
  const selected = config(true, true);
  const media = [{ type: "text", text: "canonical media" }, { type: "image", data: "inert-image", mimeType: "image/png" }];
  const samples: Array<{ prompt: string | undefined; messages: Message[] }> = [
    { prompt: undefined, messages: [] },
    { prompt: "", messages: [{ role: "user", content: "transient", originalContent: media }] },
    { prompt: "Bearer inert-test-value", messages: [{ role: "user", content: "x".repeat(9_000) }] }
  ];
  for (const [index, sample] of samples.entries()) {
    freeze(sample.messages); const f = fixture();
    await finish(f, receiver(selected), undefined, sample);
    await verifyLines(f, selected, `edge/${index}`, sample);
    assert.deepEqual(f.counts, { messages: 1, system: 1, sink: 1 });
    assert.deepEqual(plain(f.events[0]?.input), plain({ systemPrompt: f.api.systemPromptForTelemetry(sample.prompt), messages: f.api.messagesForTelemetry(sample.messages) }));
    assert.doesNotMatch(f.lines[0]!, /inert-test-value|transient/u);
  }
});
