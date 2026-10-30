import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only the real snapshot method and four list wrappers execute. Runtime construction,
// catalogs, configuration, projects and all Host/service boundaries are inert doubles.
const root = process.env.BINY_WORKSPACE_CHOICE_SOURCE_ROOT ?? process.cwd();
const desktopPath = process.env.BINY_WORKSPACE_CHOICE_BASELINE ?? path.join(root, "src/desktop/electron/main/DesktopAgentManager.ts");
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
const desktop = parse(desktopPath);
const manager = parse(path.join(root, "src/llm/ModelManager.ts"));
const owner = one(desktop.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "DesktopAgentManager"), "snapshot owner");
const method = one(owner.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && node.name.getText(desktop) === "workspaceSnapshot"), "complete snapshot method");
assert.ok(method.body);
const helpers = ["listModelChoices", "listConfiguredModelChoices", "listPickerModelChoices", "filterPickerModelChoices"].map(name => one(
  manager.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name));
const calls = new Set([
  "this.projects.refreshStoredProject", "this.residentRuntime", "this.runtimeSnapshots", "Promise.all",
  "this.configStore.load", "this.configStore.load(project.path).catch", "this.projects.listWorkspaceSessions", "this.projectEvents",
  "restoreProviderCatalogs", "Object.keys", "listConfiguredModelChoices", "listPickerModelChoices", "filterPickerModelChoices",
  "pickerModels.some", "modelRuntimeInfo", "pickerModels.sort", "Number", "this.readRuntimeProjection",
  "runtime?.getSnapshot", "this.draftSessionIds.get", "Object.fromEntries", "this.runtimeSnapshots(projectId).map", "this.state.selectedSessionId",
  "describeModelConnections", "this.runtimeErrors.get", "listModelChoices", "new ModelRuntime(config, catalogs).listModels", "models.filter",
  "listModelChoices(config, catalogs).filter"
]);
for (const [nodes, source] of [[[method], desktop], [helpers, manager]] as const) {
  for (const node of nodes) {
    const inspect = (child: ts.Node): void => {
      assert.ok(!ts.isImportDeclaration(child));
      if (ts.isCallExpression(child)) assert.ok(calls.has(child.expression.getText(source)), `unreviewed call: ${child.expression.getText(source)}`);
      if (ts.isNewExpression(child)) assert.equal(child.expression.getText(source), "ModelRuntime", "only inert Runtime may be constructed");
      ts.forEachChild(child, inspect);
    };
    inspect(node);
  }
}
const compiled = ts.transpileModule(
  helpers.map(node => node.getText(manager).replace(/^export /u, "")).join("\n") + "\n({ " + method.getText(desktop) + " });",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true }
);
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Choice {
  alias: string; source: "configured" | "catalog"; available: boolean; showInPicker?: boolean;
  defaultThinking: string; contextWindow?: number; limits?: { maxInputTokens: number };
  efforts?: string[]; headers?: Record<string, string>; pricing?: { inputPerMillionTokens: number };
}
interface Configuration {
  defaultModel: string; choices: Choice[]; providers: Record<string, object>; permission: { mode: string };
  context: { memory: { enabled: boolean } }; chat: { defaultToolSelection?: string; defaultSkillSelection?: string };
  info: { modelAlias: string; thinking: string; contextWindow: number };
}
interface Snapshot extends Record<string, unknown> { models: Choice[]; pickerModels: Choice[]; requiresModelConfiguration: boolean; selectedModel?: Configuration["info"] }
interface Api { workspaceSnapshot(this: object, projectId: string, refreshDetails?: boolean): Promise<Snapshot> }
function choice(alias: string, overrides: Partial<Choice> = {}): Choice {
  return { alias, source: "configured", available: true, defaultThinking: "high", ...overrides };
}
function config(choices: Choice[] = [choice("selected"), choice("other")]): Configuration {
  return { defaultModel: "selected", choices, providers: { fixture: {} }, permission: { mode: "ask" },
    context: { memory: { enabled: true } }, chat: {}, info: { modelAlias: "selected", thinking: "off", contextWindow: 128_000 } };
}
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freeze(item);
  Object.freeze(value);
}
function fixture(initial: Configuration | undefined, resident = false) {
  let current = initial;
  let enumeration = 0;
  let construction = 0;
  let restores = 0;
  let infoCalls = 0;
  let onProjection: (() => Promise<void>) | undefined;
  const project = { id: "project", path: "/inert/project", name: "Fixture" };
  const sessions = [{ id: "history" }];
  const sessionPage = { revision: "r1", sessions };
  const runtimeSnapshot = { info: { sessionId: "resident" }, permissionMode: "plan", revision: 7 };
  const snapshotTargets: Array<string | undefined> = [];
  const draftSessionIds = new Map<string, string>();
  const runtime = { getSnapshot: (sessionId?: string) => { snapshotTargets.push(sessionId); return runtimeSnapshot; } };
  const managed = resident ? { runtime } : undefined;
  const projection = { tasks: { tasks: [], hasMore: false }, graphs: [] };
  const catalogs = [["fixture", [{ id: "catalog-only" }]]];
  const modelsStore = {};
  class InertModelRuntime {
    private readonly selected: Configuration;
    constructor(selected: Configuration, actualCatalogs: unknown) {
      assert.equal(actualCatalogs, catalogs);
      construction += 1;
      this.selected = selected;
    }
    listModels(): Choice[] {
      enumeration += 1;
      // Fresh plain values emulate independent model enumeration, without provider code.
      return this.selected.choices.map(item => ({ ...item }));
    }
  }
  class InertHostClient {}
  const api = runInNewContext(compiled.outputText, {
    ModelRuntime: InertModelRuntime, RuntimeHostClient: InertHostClient,
    restoreProviderCatalogs: async (aliases: string[], store: unknown, providers: unknown) => {
      restores += 1; assert.deepEqual(plain(aliases), ["fixture"]); assert.equal(store, modelsStore);
      assert.equal(providers, current?.providers); return catalogs;
    },
    modelRuntimeInfo: (selected: Configuration, actualCatalogs: unknown) => {
      assert.equal(actualCatalogs, catalogs); infoCalls += 1; return { ...selected.info };
    },
    describeModelConnections: () => [{ providerAlias: "fixture", hasCredential: true }]
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
  const receiver = {
    projects: { refreshStoredProject: async (id: string, _refresh: boolean) => {
      assert.equal(id, "project"); return project;
    }, listWorkspaceSessions: async () => ({ sessions, sessionPage }) },
    configStore: { load: async () => { if (!current) throw new Error("configuration unavailable"); return current; } },
    residentRuntime: () => managed,
    runtimeSnapshots: () => resident ? [runtimeSnapshot] : [],
    projectEvents: () => new Map(), modelsStore,
    readRuntimeProjection: async () => { await onProjection?.(); return projection; },
    runtimeErrors: new Map([["project", { kind: "fixture-error" }]]),
    draftSessionIds,
    state: { selectedSessionId: () => "history" }
  };
  return {
    snapshot: (refresh = true) => api.workspaceSnapshot.call(receiver, "project", refresh),
    setDraftSession: (sessionId: string) => { draftSessionIds.set("project", sessionId); },
    snapshotTargets,
    setConfig: (next: Configuration | undefined) => { current = next; },
    setProjection: (next: () => Promise<void>) => { onProjection = next; },
    counts: () => ({ enumeration, construction, restores, infoCalls }),
    expected: (selected: Configuration | undefined): Snapshot => {
      const models = selected?.choices.filter(item => item.source === "configured").map(item => ({ ...item })) ?? [];
      const pickerModels = models.filter(item => item.available && item.showInPicker !== false);
      const active = selected && pickerModels.some(item => item.alias === selected.defaultModel);
      if (active) {
        pickerModels.sort((left, right) => Number(right.alias === selected.info.modelAlias) - Number(left.alias === selected.info.modelAlias));
        pickerModels[0] = { ...pickerModels[0]!, defaultThinking: selected.info.thinking };
      }
      return { project, sessions, sessionPage, selectedSessionId: "history", runtime: resident ? runtimeSnapshot : undefined,
        sessionRuntimes: resident ? { resident: runtimeSnapshot } : {}, runtimeError: { kind: "fixture-error" },
        memory: selected?.context.memory, permissionMode: selected?.permission.mode ?? (resident ? "plan" : "ask"),
        capabilityDefaults: { tools: selected?.chat.defaultToolSelection ?? "auto", skills: selected?.chat.defaultSkillSelection ?? "auto" },
        requiresModelConfiguration: !selected || pickerModels.length === 0, pickerModels,
        selectedModel: active ? selected.info : undefined, models,
        connections: selected ? [{ providerAlias: "fixture", hasCredential: true }] : [], runtimeProjection: resident ? projection : undefined };
    }
  };
}
function verify(label: string, actual: Snapshot, expected: Snapshot): void {
  assert.deepEqual(plain(actual), plain(expected));
  assert.notEqual(actual.models, actual.pickerModels, "filter returns a separate array");
  console.log("SNAPSHOT " + JSON.stringify({ label, value: plain(actual) }));
}

test("missing configuration keeps browsing and resident permission fallback", async () => {
  const f = fixture(undefined, true);
  verify("missing", await f.snapshot(), f.expected(undefined));
  assert.deepEqual(f.counts(), { enumeration: 0, construction: 0, restores: 0, infoCalls: 0 });
});

test("empty configured choices and catalog-only entries do not enable the picker", async () => {
  for (const choices of [[], [choice("catalog-only", { source: "catalog" })]]) {
    const selected = config(choices); freeze(selected); const f = fixture(selected);
    verify("empty-" + choices.length, await f.snapshot(), f.expected(selected));
  }
});

test("disabled, missing-key and hidden choices remain in settings but not the picker", async () => {
  // Provider availability is an already-computed boundary; real checks are covered by public CI tests.
  const selected = config([choice("selected"), choice("disabled", { available: false }), choice("missing-key", { available: false }),
    choice("hidden", { showInPicker: false }), choice("catalog", { source: "catalog" }), choice("legacy", { showInPicker: undefined })]);
  freeze(selected); const f = fixture(selected);
  verify("filtering", await f.snapshot(), f.expected(selected));
});

test("default ordering, thinking override and nested budgets preserve the settings values", async () => {
  const selected = config([choice("other"), choice("selected", { contextWindow: 128_000, limits: { maxInputTokens: 120_000 },
    efforts: ["high", "max"], headers: { "X-Fixture": "ordinary" }, pricing: { inputPerMillionTokens: 2 } })]);
  selected.chat = { defaultToolSelection: "none", defaultSkillSelection: "all" };
  freeze(selected); const before = JSON.stringify(selected); const f = fixture(selected);
  const result = await f.snapshot(); verify("metadata", result, f.expected(selected));
  assert.deepEqual(Array.from(result.models, item => item.alias), ["other", "selected"]);
  assert.equal(result.models[1]?.defaultThinking, "high");
  assert.equal(result.pickerModels[0]?.defaultThinking, "off");
  assert.notEqual(result.pickerModels[0], result.models[1]);
  assert.equal(JSON.stringify(selected), before);
});

test("an unavailable default still permits a configured available alternative", async () => {
  const selected = config([choice("selected", { available: false }), choice("alternative")]);
  const f = fixture(selected); const result = await f.snapshot(); verify("alternative", result, f.expected(selected));
  assert.equal(result.requiresModelConfiguration, false); assert.equal(result.selectedModel, undefined);
});

test("successive calls use the new configuration instead of a cross-call cache", async () => {
  const first = config(); const f = fixture(first);
  verify("first", await f.snapshot(), f.expected(first));
  const second = config([choice("replacement")]); second.defaultModel = "replacement";
  second.info = { modelAlias: "replacement", thinking: "max", contextWindow: 512_000 };
  f.setConfig(second); verify("second", await f.snapshot(), f.expected(second));
});

test("the selected-model info still recomputes after the existing projection await", async () => {
  const selected = config(); const f = fixture(selected, true);
  f.setProjection(async () => { selected.info = { ...selected.info, thinking: "max" }; });
  const result = await f.snapshot();
  const expected = f.expected(selected); expected.pickerModels[0] = { ...expected.pickerModels[0]!, defaultThinking: "off" };
  verify("projection-boundary", result, expected);
  assert.equal(result.selectedModel?.thinking, "max"); assert.equal(f.counts().infoCalls, 2);
});

test("one snapshot enumerates the model choices once", async () => {
  const selected = config(); const f = fixture(selected);
  const result = await f.snapshot(); verify("count", result, f.expected(selected));
  console.log("COUNTS " + JSON.stringify(f.counts()));
  assert.equal(f.counts().enumeration, 1, "one catalog enumeration per workspace snapshot");
  assert.equal(f.counts().construction, 1, "inert list-wrapper Runtime construction only, not a macOS measurement");
});

test("workspace snapshot reads the admitted draft without changing model enumeration", async () => {
  const selected = config(); const f = fixture(selected, true);
  f.setDraftSession("admitted-draft");
  verify("draft-target", await f.snapshot(), f.expected(selected));
  assert.deepEqual(f.snapshotTargets, ["admitted-draft"]);
  assert.equal(f.counts().enumeration, 1);
});
