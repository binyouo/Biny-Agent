/** Actual projection and selection branches with inert responses; no ACP transport or process. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const file = ts.createSourceFile("client.ts", readFileSync(path.join(process.cwd(), "src/acp/client.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function unique<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
  const found: T[] = [];
  const visit = (node: ts.Node): void => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(file); assert.equal(found.length, 1); return found[0]!;
}
const helpers = ["sessionInfo", "configInfo"].map(name => unique((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name));
const mode = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file) === "launch.modeId");
const model = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file) === 'input.model !== "default" && input.model !== info.currentModel');
const update = unique((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(file) === 'params.update.sessionUpdate === "config_option_update"');
const calls = new Set(["configInfo", "connection.agent.request", "this.info.modes.some", "info.models.some"]);
function check(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    assert.ok(calls.has(expression.getText(file)) || ts.isPropertyAccessExpression(expression) && ["map", "flatMap"].includes(expression.name.text), `Unreviewed projection call: ${expression.getText(file)}`);
  }
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(file), "Error");
  ts.forEachChild(node, check);
}
for (const node of [...helpers, mode, model, update]) check(node);
const source = `${helpers.map(node => node.getText(file)).join("\n")}\nasync function setMode(launch, connection) { const sessionId = this.info.sessionId; ${mode.getText(file)} }\nasync function setModel(input, connection) { const info = this.info; ${model.getText(file)} }\nfunction notify(params) { ${update.getText(file)} }\nglobalThis.api = { sessionInfo, configInfo, setMode, setModel, notify };`;
assert.equal(/spawn|readBinding|writeBinding|onPermission|request_permission|session\/prompt|session\/cancel|close\(/u.test(source), false);
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
interface Choice { value: string; name: string }
interface Option { id: string; name: string; type: string; category?: string; currentValue: string; options: Array<Choice | { group: string; options: Choice[] }> }
interface Info { sessionId: string; models: Array<{ id: string; name: string }>; modes: Array<{ id: string; name: string }>; currentModel?: string; currentMode?: string; modelConfigId?: string; modeConfigId?: string; marker?: string }
interface State { info: Info }
interface Connection { agent: { request(method: string, params: Record<string, string>): Promise<{ configOptions: Option[] }> } }
interface Api {
  sessionInfo(sessionId: string, response: unknown): Info;
  configInfo(options?: Option[] | null): Partial<Info>;
  setMode(this: State, launch: { modeId?: string }, connection: Connection): Promise<void>;
  setModel(this: State, input: { model: string }, connection: Connection): Promise<void>;
  notify(this: State, params: { update: { sessionUpdate: string; configOptions: Option[] } }): void;
}
const api = context.api as Api;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const modelOption = (currentValue = "first"): Option => ({ id: "llm", name: "Model", category: "model", type: "select", currentValue, options: [{ value: "first", name: "First" }, { value: "second", name: "Second" }] });
const modeOption = (currentValue = "ask"): Option => ({ id: "execution", name: "Mode", category: "mode", type: "select", currentValue, options: [{ value: "ask", name: "Ask" }, { value: "plan", name: "Plan" }] });
const initial = (): Info => ({ ...api.sessionInfo("fixture", { configOptions: [modelOption(), modeOption()] }), marker: "unrelated" });
function transport(options: Option[]) {
  const requests: Array<{ method: string; params: Record<string, string> }> = [];
  const connection: Connection = { agent: { request: async (method, params) => {
    assert.ok(["session/set_config_option", "session/set_model", "session/set_mode"].includes(method));
    requests.push({ method, params: { ...params } }); return { configOptions: options };
  } } };
  return { connection, requests };
}
function assertCleared(info: Partial<Info>, category: "model" | "mode"): void {
  const values = category === "model" ? info.models : info.modes;
  assert.ok(Array.isArray(values), `Removed ${category} selector must project an explicit empty array`);
  assert.deepEqual(plain(values), []);
  assert.equal(category === "model" ? info.currentModel : info.currentMode, undefined);
  assert.equal(category === "model" ? info.modelConfigId : info.modeConfigId, undefined);
}
const legacy = { models: { currentModelId: "old-model", availableModels: [{ modelId: "old-model", name: "Old model" }] }, modes: { currentModeId: "old-mode", availableModes: [{ id: "old-mode", name: "Old mode" }] } };
for (const configOptions of [undefined, null]) {
  test(`absent legacy configuration remains compatible: ${String(configOptions)}`, () => {
    assert.deepEqual(plain(api.configInfo(configOptions)), {});
    const info = api.sessionInfo("legacy", { ...legacy, configOptions });
    assert.equal(info.sessionId, "legacy"); assert.equal(info.currentModel, "old-model"); assert.equal(info.currentMode, "old-mode");
    assert.deepEqual(plain(info.models), [{ id: "old-model", name: "Old model" }]);
    assert.deepEqual(plain(info.modes), [{ id: "old-mode", name: "Old mode" }]);
  });
}
test("explicit empty startup snapshot replaces legacy selectors", () => {
  const info = api.sessionInfo("fixture", { ...legacy, configOptions: [] });
  assertCleared(info, "model"); assertCleared(info, "mode"); assert.equal(info.sessionId, "fixture");
});
for (const category of ["model", "mode"] as const) {
  test(`full snapshot clears removed ${category} fields, including own undefined properties`, () => {
    const projection = api.configInfo(category === "model" ? [modeOption()] : [modelOption()]);
    assertCleared(projection, category);
    for (const key of category === "model" ? ["currentModel", "modelConfigId"] : ["currentMode", "modeConfigId"]) assert.ok(Object.hasOwn(projection, key));
    const info = { ...initial(), ...projection };
    assertCleared(info, category); assert.equal(info.sessionId, "fixture"); assert.equal(info.marker, "unrelated");
  });
}
test("grouped options retain advertised order, identifiers and current values", () => {
  const option = modelOption("second"); option.options = [{ group: "main", options: [{ value: "second", name: "Second" }, { value: "first", name: "First" }] }];
  const info = api.sessionInfo("fixture", { configOptions: [option, modeOption("plan")] });
  assert.deepEqual(plain(info.models), [{ id: "second", name: "Second" }, { id: "first", name: "First" }]);
  assert.equal(info.currentModel, "second"); assert.equal(info.modelConfigId, "llm"); assert.equal(info.currentMode, "plan"); assert.equal(info.modeConfigId, "execution");
});
test("unknown categories or option types do not keep old selectors alive", () => {
  const info = { ...initial(), ...api.configInfo([{ ...modelOption(), category: "thought_level" }, { ...modeOption(), type: "future" }]) };
  assertCleared(info, "model"); assertCleared(info, "mode");
});
for (const configOptions of [[], [modelOption("second")], [modeOption("plan")]]) {
  test(`actual notification projection replaces category set ${configOptions.map(option => option.category).join(",") || "empty"}`, () => {
    const state = { info: initial() };
    api.notify.call(state, { update: { sessionUpdate: "config_option_update", configOptions } });
    assert.equal(state.info.sessionId, "fixture"); assert.equal(state.info.marker, "unrelated");
    if (!configOptions.some(option => option.category === "model")) assertCleared(state.info, "model");
    else assert.equal(state.info.currentModel, "second");
    if (!configOptions.some(option => option.category === "mode")) assertCleared(state.info, "mode");
    else assert.equal(state.info.currentMode, "plan");
  });
}
test("unrelated update does not change configuration", () => {
  const state = { info: initial() }; const previous = state.info;
  api.notify.call(state, { update: { sessionUpdate: "agent_message_chunk", configOptions: [] } });
  assert.equal(state.info, previous);
});
for (const configOptions of [[], [modelOption("second"), modeOption("ask")]]) {
  test(`modern mode response is authoritative: ${configOptions.length ? "normalized" : "removed"}`, async () => {
    const state = { info: initial() }; const t = transport(configOptions);
    await api.setMode.call(state, { modeId: "plan" }, t.connection);
    assert.deepEqual(t.requests, [{ method: "session/set_config_option", params: { sessionId: "fixture", configId: "execution", value: "plan" } }]);
    if (!configOptions.length) { assertCleared(state.info, "model"); assertCleared(state.info, "mode"); }
    else { assert.equal(state.info.currentMode, "ask"); assert.equal(state.info.currentModel, "second"); }
    assert.equal(state.info.marker, "unrelated");
  });
}
for (const configOptions of [[], [modelOption("first"), modeOption("plan")]]) {
  test(`modern model response is authoritative: ${configOptions.length ? "normalized" : "removed"}`, async () => {
    const state = { info: initial() }; const old = state.info; const t = transport(configOptions);
    await api.setModel.call(state, { model: "second" }, t.connection);
    assert.deepEqual(t.requests, [{ method: "session/set_config_option", params: { sessionId: "fixture", configId: "llm", value: "second" } }]);
    if (!configOptions.length) { assertCleared(state.info, "model"); assertCleared(state.info, "mode"); }
    else { assert.equal(state.info.currentModel, "first"); assert.equal(state.info.currentMode, "plan"); }
    assert.equal(old.currentModel, "first", "Do not rewrite the retired snapshot after modern replacement");
  });
}
test("legacy mode setter still records successful requested mode", async () => {
  const state = { info: { ...initial(), modeConfigId: undefined } }; const t = transport([]);
  await api.setMode.call(state, { modeId: "plan" }, t.connection);
  assert.equal(state.info.currentMode, "plan"); assert.equal(t.requests[0]?.method, "session/set_mode");
});
test("legacy model setter still records successful requested model", async () => {
  const state = { info: { ...initial(), modelConfigId: undefined } }; const t = transport([]);
  await api.setModel.call(state, { model: "second" }, t.connection);
  assert.equal(state.info.currentModel, "second"); assert.equal(t.requests[0]?.method, "session/set_model");
});
test("same model on the next selection does not request another change", async () => {
  const state = { info: initial() }; const t = transport([modelOption("second"), modeOption()]);
  await api.setModel.call(state, { model: "second" }, t.connection);
  await api.setModel.call(state, { model: "second" }, t.connection);
  assert.equal(t.requests.length, 1);
});
test("removed model cannot be selected through the stale configuration ID", async () => {
  const state = { info: initial() }; const t = transport([]);
  api.notify.call(state, { update: { sessionUpdate: "config_option_update", configOptions: [modeOption()] } });
  await assert.rejects(api.setModel.call(state, { model: "second" }, t.connection), /ACP 模型不可用/u);
  assert.equal(t.requests.length, 0);
});
test("default model does not invoke a selector", async () => {
  const state = { info: initial() }; const t = transport([]);
  await api.setModel.call(state, { model: "default" }, t.connection); assert.equal(t.requests.length, 0);
});
for (const kind of ["model", "mode"] as const) {
  test(`failed ${kind} setting preserves prior snapshot`, async () => {
    const state = { info: initial() }; const previous = state.info; const before = plain(previous);
    const failure = new Error("synthetic rejection");
    const connection: Connection = { agent: { request: async () => { throw failure; } } };
    const call = kind === "model" ? api.setModel.call(state, { model: "second" }, connection) : api.setMode.call(state, { modeId: "plan" }, connection);
    await assert.rejects(call, error => error === failure);
    assert.equal(state.info, previous); assert.deepEqual(plain(state.info), before);
  });
}
