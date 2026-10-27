/** Actual catalog render projection and effect only; hooks and catalog IPC are inert. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const filename = "src/desktop/renderer/src/App.tsx";
const source = ts.createSourceFile(filename, readFileSync(path.join(process.cwd(), filename), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp");
assert.ok(app?.body);
const names = new Set(["composerCatalog", "composerSkills", "composerTools", "composerSkillWarnings"]);
function includesBinding(name: ts.BindingName): boolean {
  return ts.isIdentifier(name) ? names.has(name.text) : name.elements.some(element => ts.isBindingElement(element) && includesBinding(element.name));
}
const declarations = app.body.statements.filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => includesBinding(declaration.name)));
assert.ok(declarations.length === 2 || declarations.length === 3);
const effects = app.body.statements.filter(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(source) === "useEffect" && statement.getText(source).includes("window.biny.skillCatalog(projectId)"));
assert.equal(effects.length, 1);
const allowedCalls = new Set(["useState", "useMemo", "useEffect", "setComposerCatalog", "setComposerSkills", "setComposerTools", "setComposerSkillWarnings",
  "Promise.all", "window.biny.skillCatalog", "window.biny.skillSettings", "window.biny.toolCatalog", "settings.activations.map", "catalog.skills.filter",
  "enabledById.get", "setWarning", "errorMessage"]);
function promiseChain(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (node.expression.getText(source) === "Promise.all") return true;
  return ts.isPropertyAccessExpression(node.expression) && ["then", "catch"].includes(node.expression.name.text) && promiseChain(node.expression.expression);
}
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)) || promiseChain(node), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Map");
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  ts.forEachChild(node, audit);
}
for (const node of [...declarations, ...effects]) audit(node);
const extracted = `function render(workspace, settingsOpen, composerCatalogNonce, composerResourceRevision) {
${declarations.map(node => node.getText(source)).join("\n")}
${effects[0]!.getText(source)}
return {skills: composerSkills, tools: composerTools, warnings: composerSkillWarnings};
}\nglobalThis.renderCatalog = render;`;
assert.equal(/require\s*\(|import\s*\(|process|setTimeout|fetch\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);

interface Skill { id: string; name: string }
interface Tool { name: string }
interface Catalog { skills: Skill[]; tools: Tool[]; warnings: string[] }
interface Request {
  project: string;
  catalog: ReturnType<typeof deferred<{ skills: Skill[]; warnings: string[] }>>;
  settings: ReturnType<typeof deferred<{ activations: { id: string; enabled: boolean }[] }>>;
  tools: ReturnType<typeof deferred<Tool[]>>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const data = (project: string): Catalog => ({ skills: [{ id: `${project}-skill`, name: `${project}-skill` }], tools: [{ name: `${project}-tool` }], warnings: [`${project}-warning`] });
const empty: Catalog = { skills: [], tools: [], warnings: [] };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function flush(): Promise<void> { for (let count = 0; count < 6; count++) await Promise.resolve(); }
function fixture() {
  const slots: unknown[] = [], requests: Request[] = [], errors: string[] = [];
  const memoSlots: { dependencies: unknown[]; value: unknown }[] = [];
  let cursor = 0, memoCursor = 0, previousDependencies: unknown[] | undefined;
  let pending: { effect: () => (() => void) | undefined; dependencies: unknown[] } | undefined;
  let cleanup: (() => void) | undefined;
  const currentRequest = (project: string): Request => { const request = requests.at(-1); assert.ok(request); assert.equal(request.project, project); return request; };
  const context = createContext({
    useState: (initial?: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: unknown) => { slots[index] = value; }]; },
    useMemo: (factory: () => unknown, dependencies: unknown[]) => {
      const index = memoCursor++, previous = memoSlots[index];
      if (previous?.dependencies.length === dependencies.length && dependencies.every((value, dependencyIndex) => Object.is(value, previous.dependencies[dependencyIndex]))) return previous.value;
      const value = factory(); memoSlots[index] = { dependencies: [...dependencies], value }; return value;
    },
    useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => { pending = { effect, dependencies }; },
    setWarning: (message: string) => { errors.push(message); }, errorMessage: (error: Error) => error.message,
    window: { biny: {
      skillCatalog: (project: string) => { const request: Request = { project, catalog: deferred(), settings: deferred(), tools: deferred() }; requests.push(request); return request.catalog.promise; },
      skillSettings: (project: string) => currentRequest(project).settings.promise,
      toolCatalog: (project: string) => currentRequest(project).tools.promise
    } }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const renderCatalog = context.renderCatalog as (workspace: { project: { id: string } } | undefined, settingsOpen: boolean, nonce: number, revision: number) => Catalog;
  return {
    requests, errors,
    render(project: string | undefined, settingsOpen = false, nonce = 0): Catalog { cursor = 0; memoCursor = 0; return renderCatalog(project === undefined ? undefined : { project: { id: project } }, settingsOpen, nonce, 0); },
    commit(): void {
      assert.ok(pending);
      const next = pending; pending = undefined;
      if (previousDependencies?.length === next.dependencies.length && next.dependencies.every((value, index) => Object.is(value, previousDependencies![index]))) return;
      cleanup?.(); previousDependencies = next.dependencies; cleanup = next.effect();
    },
    close(): void { cleanup?.(); cleanup = undefined; },
    async resolve(index: number, payload = data(requests[index]!.project), disabled = false): Promise<void> {
      const request = requests[index]!;
      request.catalog.resolve({ skills: payload.skills, warnings: payload.warnings });
      request.settings.resolve({ activations: payload.skills.map(skill => ({ id: skill.id, enabled: !disabled })) });
      request.tools.resolve(payload.tools); await flush();
    },
    async reject(index: number): Promise<void> { requests[index]!.catalog.reject(new Error("catalog unavailable")); requests[index]!.settings.resolve({ activations: [] }); requests[index]!.tools.resolve([]); await flush(); }
  };
}
async function loadedA() { const f = fixture(); f.render("a"); f.commit(); await f.resolve(0); assert.deepEqual(plain(f.render("a")), data("a")); f.commit(); return f; }

test("new workspace hides published old skills, tools and warnings before effects run", async () => {
  const f = await loadedA(); assert.deepEqual(plain(f.render("b")), empty); assert.equal(f.requests.length, 1); f.close();
});
test("new workspace stays empty while pending and publishes its own complete catalog", async () => {
  const f = await loadedA(); f.render("b"); f.commit(); assert.deepEqual(plain(f.render("b")), empty);
  await f.resolve(1); assert.deepEqual(plain(f.render("b")), data("b")); f.close();
});
test("same-workspace refresh retains the already loaded catalog", async () => {
  const f = await loadedA(); assert.deepEqual(plain(f.render("a", false, 1)), data("a")); f.commit();
  assert.deepEqual(plain(f.render("a", false, 1)), data("a")); await f.resolve(1, data("a-new"));
  assert.deepEqual(plain(f.render("a", false, 1)), data("a-new")); f.close();
});
test("missing workspace hides the old catalog before cleanup and clears it on commit", async () => {
  const f = await loadedA(); assert.deepEqual(plain(f.render(undefined)), empty); f.commit(); assert.deepEqual(plain(f.render(undefined)), empty); f.close();
});
test("A to B to A can reuse the still-owned A snapshot while refreshing A", async () => {
  const f = await loadedA(); f.render("b"); f.commit();
  assert.deepEqual(plain(f.render("a")), data("a")); f.commit(); await f.resolve(1);
  assert.deepEqual(plain(f.render("a")), data("a")); await f.resolve(2, data("a-new"));
  assert.deepEqual(plain(f.render("a")), data("a-new")); f.close();
});
test("A to B to A cannot project a published B snapshot into A", async () => {
  const f = await loadedA(); f.render("b"); f.commit(); await f.resolve(1); assert.deepEqual(plain(f.render("b")), data("b"));
  assert.deepEqual(plain(f.render("a")), empty); f.close();
});
test("late A fulfillment cannot overwrite B", async () => {
  const f = fixture(); f.render("a"); f.commit(); f.render("b"); f.commit(); await f.resolve(1); await f.resolve(0);
  assert.deepEqual(plain(f.render("b")), data("b")); f.close();
});
test("late A rejection cannot clear B or show an obsolete error", async () => {
  const f = fixture(); f.render("a"); f.commit(); f.render("b"); f.commit(); await f.resolve(1); await f.reject(0);
  assert.deepEqual(plain(f.render("b")), data("b")); assert.deepEqual(f.errors, []); f.close();
});
test("current request failure clears its catalog and reports the current error", async () => {
  const f = await loadedA(); f.render("a", false, 1); f.commit(); await f.reject(1);
  assert.deepEqual(plain(f.render("a", false, 1)), empty); assert.deepEqual(f.errors, ["无法加载技能补全：catalog unavailable"]); f.close();
});
test("settings-open navigation hides another project's catalog without scanning", async () => {
  const f = await loadedA(); assert.deepEqual(plain(f.render("b", true)), empty); f.commit(); assert.equal(f.requests.length, 1);
  f.render("b", false); f.commit(); await f.resolve(1); assert.deepEqual(plain(f.render("b")), data("b")); f.close();
});
test("settings-open refresh in the same workspace preserves its catalog", async () => {
  const f = await loadedA(); assert.deepEqual(plain(f.render("a", true)), data("a")); f.commit(); assert.equal(f.requests.length, 1); f.close();
});
test("disabled skills remain filtered while tools and warnings are preserved", async () => {
  const f = fixture(); f.render("a"); f.commit(); await f.resolve(0, data("a"), true);
  assert.deepEqual(plain(f.render("a")), { ...data("a"), skills: [] }); f.close();
});
test("disposed request cannot publish a catalog", async () => {
  const f = fixture(); f.render("a"); f.commit(); f.close(); await f.resolve(0);
  assert.deepEqual(plain(f.render("a")), empty);
});
