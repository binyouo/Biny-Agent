/** Pure extracted renderer closures only. Run under an external process watchdog:
 * From the source tree cwd, execute the compiled script under an external watchdog:
 * timeout 30s node /path/to/compiled/provider-model-test-owner.test.js
 * No React, renderer/main imports, IPC, credentials, sockets or model execution.
 * Scope: saves through the model-options dialog, which stays modal while saving.
 * Arbitrary new same-target tests during a pending save are not covered by this fix.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const sourcePath = resolve(process.cwd(), "src/desktop/renderer/src/components/settings/ProviderSettings.tsx");
const source = readFileSync(sourcePath, "utf8");
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "ProviderSettings");
assert.ok(component?.body, "source must expose the actual ProviderSettings body");
const statements = component.body.statements;
function declaration(name: string, optional = false): string {
  const found = statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.equal(found.length, optional && !found.length ? 0 : 1, `unique actual declaration: ${name}`);
  return found[0]?.getText(file) ?? "";
}
const effect = statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(file) === "useEffect"
  && node.getText(file).includes("testGenerationRef.current += 1"));
assert.equal(effect.length, 1, "extract actual provider/connection invalidation effect");
// Baseline without owner must still execute the old business behavior, not fail extraction.
const extracted = [declaration("testGenerationRef"), declaration("testOwnerRef", true), effect[0]!.getText(file),
  declaration("runTest"), declaration("saveModelOptions")].join("\n");
const allowedCalls = new Set(["useRef", "useEffect", "useCallback", "testConfiguration", "setTestMenuOpen",
  "setTestingAlias", "setTestResult", "onTest", "providerErrorMessage", "apiFormatOption",
  "choiceUpsertInput", "settingsDraft.saveModels"]);
const extractedFile = ts.createSourceFile("extracted.ts", extracted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function validate(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node), "no imported execution");
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(extractedFile)), `unexpected real callee: ${node.expression.getText(extractedFile)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(extractedFile), "Error", "only inert Error construction");
  ts.forEachChild(node, validate);
}
validate(extractedFile);
const javascript = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Model = { alias: string; model: string; provider: string; apiBackend: string };
type Result = { ok: boolean; message: string };
type SaveResult = { status: string; message?: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const modelA: Model = { alias: "alias-a", model: "model-a", provider: "provider-a", apiBackend: "chat_completions" };
const modelB: Model = { alias: "alias-b", model: "model-b", provider: "provider-b", apiBackend: "chat_completions" };
const options = { profile: {}, tools: true, reasoning: false, headers: {}, apiFormat: "responses" };
function fixture() {
  const state: { testing?: string; result?: { alias: string; result: Result }; writes: unknown[] } = { writes: [] };
  const tests: Array<ReturnType<typeof deferred<Result>>> = [];
  const saves: Array<ReturnType<typeof deferred<SaveResult>>> = [];
  let reset = () => {};
  const group = { provider: modelA.provider, enabled: true };
  const context = createContext({
    group, providerAlias: modelA.provider, connection: { protocol: "openai-compatible", apiBackend: undefined, baseUrl: "https://fixture.invalid" }, catalog: {},
    useRef: (current?: unknown) => ({ current }),
    useEffect: (callback: () => void) => { reset = callback; },
    useCallback: <T>(callback: T) => callback,
    setTestMenuOpen: () => {},
    setTestingAlias: (value?: string) => { state.testing = value; },
    setTestResult: (value?: { alias: string; result: Result }) => { state.result = value; },
    testConfiguration: (model: Model) => ({ alias: model.alias, model: model.model, providerAlias: group.provider, apiBackend: model.apiBackend }),
    onTest: () => { const pending = deferred<Result>(); tests.push(pending); return pending.promise; },
    providerErrorMessage: (error: unknown) => String(error),
    apiFormatOption: (id: string) => ({ protocol: "openai-compatible", apiBackend: id }),
    choiceUpsertInput: (model: Model, input: Record<string, unknown>) => ({ alias: model.alias, model: model.model, ...input }),
    settingsDraft: {
      draft: {},
      saveModels: (build: (snapshot: { models: { modelProfiles: object } }) => unknown) => {
        state.writes.push(build({ models: { modelProfiles: {} } }));
        const pending = deferred<SaveResult>(); saves.push(pending); return pending.promise;
      }
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(javascript, { filename: "provider-model-test-owner.extracted.js" }).runInContext(context, { timeout: 500 });
  reset();
  const invoke = <T>(expression: string, values: Record<string, unknown> = {}): T => {
    Object.assign(context, values);
    return new Script(expression).runInContext(context, { timeout: 500 }) as T;
  };
  return {
    state, tests, saves,
    result: () => state.result,
    run: (model = modelA) => invoke<Promise<void>>("runTest(fixtureModel)", { fixtureModel: model }),
    save: (model = modelA) => invoke<Promise<void>>("saveModelOptions(fixtureModel.provider, fixtureModel, fixtureOptions)", { fixtureModel: model, fixtureOptions: options }),
    switchProvider: (model: Model) => { group.provider = model.provider; reset(); },
    generationEdit: () => invoke<void>("testGenerationRef.current += 1; setTestingAlias(undefined); setTestResult(undefined)")
  };
}
const success: Result = { ok: true, message: "old synthetic success" };
const fresh: Result = { ok: true, message: "fresh synthetic success" };

for (const outcome of ["success", "failure", "reject"] as const) test(`saved target alone rejects stale ${outcome} without a replacement test`, { timeout: 2000 }, async () => {
  const h = fixture(); const old = h.run(); const saving = h.save();
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  // Do not start another test: its generation bump would hide the original bug.
  if (outcome === "reject") h.tests[0]!.reject(new Error("synthetic stale rejection"));
  else h.tests[0]!.resolve(outcome === "success" ? success : { ok: false, message: "stale failure" });
  await old;
  assert.equal(h.result(), undefined, "saved model configuration must not inherit the old result");
  assert.equal(h.state.testing, undefined);
});

for (const outcome of ["success", "failure", "reject"] as const) test(`saved target retires late ${outcome} and its finally cannot clear fresh test`, { timeout: 2000 }, async () => {
  const h = fixture();
  const old = h.run();
  const saving = h.save();
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  assert.equal(h.state.testing, undefined);
  const next = h.run({ ...modelA, apiBackend: "responses" });
  if (outcome === "reject") h.tests[0]!.reject(new Error("synthetic old rejection"));
  else h.tests[0]!.resolve(outcome === "success" ? success : { ok: false, message: "old failure" });
  await old;
  assert.equal(h.result(), undefined);
  assert.equal(h.state.testing, modelA.provider, "retired finally must not stop fresh spinner");
  h.tests[1]!.resolve(fresh); await next;
  assert.equal(h.result()?.result.message, fresh.message);
});

for (const ok of [true, false]) test(`successful save clears completed ${ok ? "success" : "failure"} card`, { timeout: 2000 }, async () => {
  const h = fixture(); const pending = h.run(); h.tests[0]!.resolve({ ok, message: "completed" }); await pending;
  assert.ok(h.result());
  const saving = h.save(); h.saves[0]!.resolve({ status: "committed" }); await saving;
  assert.equal(h.result(), undefined);
  const write = h.state.writes[0] as { upserts: Array<{ apiBackend: string; providerApiBackend?: string }> };
  assert.equal(write.upserts[0]!.apiBackend, "responses");
  assert.equal(write.upserts[0]!.providerApiBackend, undefined);
});

for (const outcome of ["rolled_back", "cancelled", "reject"] as const) test(`unsuccessful save ${outcome} retains completed card`, { timeout: 2000 }, async () => {
  const h = fixture(); const pending = h.run(); h.tests[0]!.resolve(success); await pending;
  const card = h.result(); const saving = h.save();
  const rejected = assert.rejects(saving);
  if (outcome === "reject") h.saves[0]!.reject(new Error("synthetic save failure"));
  else h.saves[0]!.resolve({ status: outcome });
  await rejected; assert.equal(h.result(), card);
});

test("unrelated model in same provider does not retire tested model", { timeout: 2000 }, async () => {
  const h = fixture(); const pending = h.run();
  const saving = h.save({ ...modelA, alias: "other-alias", model: "other-model" });
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  assert.equal(h.state.testing, modelA.provider);
  h.tests[0]!.resolve(success); await pending;
  assert.equal(h.result()?.result.message, success.message);
});

test("old provider save cannot clear new provider test", { timeout: 2000 }, async () => {
  const h = fixture(); const old = h.run(); const saving = h.save();
  h.switchProvider(modelB); const next = h.run(modelB);
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  h.tests[0]!.resolve(success); await old;
  assert.equal(h.state.testing, modelB.provider); assert.equal(h.result(), undefined);
  h.tests[1]!.resolve(fresh); await next;
  assert.equal(h.result()?.alias, modelB.provider);
});

test("old save cannot retire a replacement test owner", { timeout: 2000 }, async () => {
  // Callback-level adversarial ordering, not a promise that this fix retires every
  // new same-target test started during save; normal modal UI prevents that path.
  const h = fixture(); const old = h.run(); const saving = h.save(); const next = h.run();
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  h.tests[0]!.resolve(success); await old;
  assert.equal(h.state.testing, modelA.provider);
  h.tests[1]!.resolve(fresh); await next;
  assert.equal(h.result()?.result.message, fresh.message);
});

test("existing generation-only field edits keep stale save and test retired", { timeout: 2000 }, async () => {
  const h = fixture(); const old = h.run(); const saving = h.save(); h.generationEdit();
  h.saves[0]!.resolve({ status: "committed" }); await saving;
  h.tests[0]!.resolve(success); await old;
  assert.equal(h.result(), undefined); assert.equal(h.state.testing, undefined);
});

test("real UI exposes model options during test but locks dialog closing while saving", () => {
  assert.match(source, /disabled=\{!choice \|\| saving\}/u);
  assert.match(source, /<SettingsDetailLayer onClose=\{\(\) => \{ if \(!saving\) onClose\(\); \}\}>/u);
  assert.match(source, /aria-label="当前模型的请求格式"/u);
  assert.match(source, /apiBackend: model\.apiBackend/u);
});
