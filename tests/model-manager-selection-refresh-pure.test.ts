/** Actual applyConfig body only: no ModelManager, provider, SDK or Host module imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Optional source-only baseline comparison; never used as an executable import path.
const root = process.env.BINY_MODEL_REFRESH_SOURCE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const file = path.join(root, "src/llm/ModelManager.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = source.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === "ModelManager");
assert.equal(classes.length, 1);
const methods = classes[0]!.members.filter(ts.isMethodDeclaration)
  .filter(node => ts.isIdentifier(node.name) && node.name.text === "applyConfig");
assert.equal(methods.length, 1);
assert.ok(methods[0]!.body);
const body = methods[0]!.body!;

// Fail closed if the extracted dependency closure changes. All allowed non-builtins
// are inert fixtures below, including both successful and failing catalog restores.
const allowedCalls = new Set([
  "this.configStore.revision", "Object.keys", "Object.keys(nextConfig.providers).filter",
  "modelCatalogCacheKey", "this.runtime.catalogsSnapshot", "this.runtime.catalogsSnapshot().filter",
  "changed.has", "catalogs.push", "restoreProviderCatalogs", "nextRuntime.createModelSettings", "Object.assign"
]);
function audit(node: ts.Node): void {
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), node.expression.getText(source));
  if (ts.isNewExpression(node)) assert.ok(["Set", "ModelRuntime"].includes(node.expression.getText(source)));
  if (ts.isIdentifier(node)) assert.equal(["process", "require", "fetch", "eval", "Function", "globalThis"].includes(node.text), false);
  ts.forEachChild(node, audit);
}
audit(body);
const emitted = ts.transpileModule(`async function applyConfig(nextConfig) ${body.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);

interface Config {
  providers: Record<string, { type: string; baseUrl: string }>;
  defaultModel: string;
  visionModel?: string;
  toolModel?: string;
}
const configuration = (visionModel?: string): Config => ({
  providers: { fixture: { type: "fixture", baseUrl: "https://fixture.invalid/a" } },
  defaultModel: "primary", ...(visionModel === undefined ? {} : { visionModel }), toolModel: "tool-old"
});
interface Snapshot {
  config: Config;
  activeSnapshot: Config;
  sharedIdentity: boolean;
  runtimeChanged: boolean;
  settingsChanged: boolean;
  revision: number;
  settled: boolean;
  error?: string;
}
function harness(initial = configuration("vision-old")) {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const run = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  run(`
    const shared = ${JSON.stringify(initial)};
    const activeSnapshot = JSON.parse(JSON.stringify(shared));
    let failure = "";
    let settled = false;
    let error;
    const previousRuntime = { catalogsSnapshot: () => [] };
    const previousSettings = { marker: "previous" };
    const state = { config: shared, configStore: { revision: () => 7 }, runtime: previousRuntime,
      activeSettings: previousSettings, observedConfigRevision: 3, modelsStore: {}, ai: {}, providerCredentials: {} };
    function modelCatalogCacheKey(alias, provider) { return alias + "::" + provider.baseUrl; }
    async function restoreProviderCatalogs() {
      if (failure === "catalog") throw new Error("catalog fixture failure");
      return [];
    }
    class ModelRuntime {
      createModelSettings() {
        if (failure === "settings") throw new Error("settings fixture failure");
        return { marker: "next" };
      }
      catalogsSnapshot() { return []; }
    }
    ${emitted.outputText}
  `);
  return {
    apply(next: Config, options: { explicitUndefined?: boolean; failure?: "catalog" | "settings" } = {}): void {
      run(`{
        const next = ${JSON.stringify(next)};
        ${options.explicitUndefined ? "next.visionModel = undefined;" : ""}
        failure = ${JSON.stringify(options.failure ?? "")}; settled = false; error = undefined;
        void applyConfig.call(state, next).then(() => { settled = true; }, cause => { error = cause.message; settled = true; });
      }`);
    },
    snapshot(): Snapshot {
      return JSON.parse(run(`JSON.stringify({ config: state.config, activeSnapshot,
        sharedIdentity: state.config === shared, runtimeChanged: state.runtime !== previousRuntime,
        settingsChanged: state.activeSettings !== previousSettings, revision: state.observedConfigRevision, settled, error })`) as string) as Snapshot;
    }
  };
}

for (const variant of ["omitted", "explicit undefined", "replacement", "already absent"] as const) {
  test(`applyConfig refreshes vision selection: ${variant}`, () => {
    const initial = configuration(variant === "already absent" ? undefined : "vision-old");
    const before = structuredClone(initial);
    const next = configuration(variant === "replacement" ? "vision-new" : undefined);
    delete next.toolModel;
    assert.equal(Object.hasOwn(next, "visionModel"), variant === "replacement", "omitted reset models the persisted JSON shape");
    const h = harness(initial);
    h.apply(next, { explicitUndefined: variant === "explicit undefined" });
    const result = h.snapshot();
    assert.equal(result.settled, true);
    assert.equal(result.error, undefined);
    assert.equal(result.config.visionModel, next.visionModel);
    assert.equal(result.config.toolModel, undefined, "existing tool-model reset remains intact");
    assert.equal(result.sharedIdentity, true, "runtime consumers retain the same shared configuration object");
    assert.equal(result.runtimeChanged, true);
    assert.equal(result.settingsChanged, true);
    assert.equal(result.revision, 7);
    assert.deepEqual(result.activeSnapshot, before, "previous turn snapshot is not rewritten");
    h.apply(next);
    assert.equal(h.snapshot().config.visionModel, next.visionModel, "repeated refresh stays converged");
  });
}

for (const failure of ["settings", "catalog"] as const) {
  test(`applyConfig preserves all committed state on ${failure} preparation failure`, () => {
    const initial = configuration("vision-old");
    const next = configuration();
    delete next.toolModel;
    if (failure === "catalog") next.providers.fixture!.baseUrl = "https://fixture.invalid/b";
    const h = harness(initial);
    h.apply(next, { failure });
    const result = h.snapshot();
    assert.equal(result.settled, true);
    assert.equal(result.error, `${failure} fixture failure`);
    assert.deepEqual(result.config, initial);
    assert.deepEqual(result.activeSnapshot, initial);
    assert.equal(result.sharedIdentity, true);
    assert.equal(result.runtimeChanged, false);
    assert.equal(result.settingsChanged, false);
    assert.equal(result.revision, 3);
  });
}
