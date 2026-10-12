import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product files only as text. Execute fixed method bodies with Map-backed
// storage; never import AgentSession, TodoStore, Recorder, Host, or an SDK.
const root = new URL("../", import.meta.url);
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const todo = source("src/session/todoStore.ts");
const agent = source("src/agent/AgentSession.ts");
function classNode(file: ts.SourceFile, name: string): ts.ClassDeclaration {
  const matches = file.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1);
  return matches[0]!;
}
const todoClass = classNode(todo, "TodoStore");
const agentClass = classNode(agent, "AgentSession");
const limits = ["maxTodoItems", "maxTodoContentLength"].map((name) => {
  const declarations = todo.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
  const matches = declarations.filter((node) => node.name.getText(todo) === name);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.initializer && ts.isNumericLiteral(matches[0]!.initializer));
  return `const ${matches[0]!.getText(todo)};`;
});
function method(owner: ts.ClassDeclaration, file: ts.SourceFile, name: string): ts.MethodDeclaration | undefined {
  const matches = owner.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  assert.ok(matches.length <= 1);
  return matches[0];
}
const todoMethods = ["initialize", "refresh", "useSession", "loadCurrentSession", "list", "replace", "promptSection", "filePath", "persist"];
const selected = todoMethods.flatMap((name) => {
  const node = method(todoClass, todo, name);
  if (name !== "refresh") assert.ok(node?.body, name);
  return node ? [node] : [];
});
const extension = method(agentClass, agent, "extensionPrompt")!;
assert.ok(extension?.body);
const helpers = ["statusMark", "normalizeItems"].map((name) => {
  const matches = todo.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1);
  return matches[0]!;
});
// Fail closed if an extracted body acquires another dependency. fs/path/UUID/
// ensureAgentDirs below are inert fixture functions, never Node's filesystem.
const calls = new Set([
  "this.loadCurrentSession", "fs.readFile", "this.filePath", "JSON.parse", "normalizeItems",
  "this.items.map", "Array.isArray", "String", "Array.from", "content.trim", "nextItems.filter",
  "this.persist", "nextItems.map", "statusMark", "path.join", "agentDir", "ensureAgentDirs",
  "randomUUID", "fs.writeFile", "JSON.stringify", "this.commitQueue.then", "fs.rename",
  "commit.catch", "fs.rm(temporary, { force: true }).catch", "fs.rm", "items.flatMap",
  "candidate.content.trim", "candidate.content.slice", "this.skillPrompt",
  "this.options.todoStore?.refresh", "selectedSkillPrompt?.trim", "this.options.subagentPrompt?.trim",
  "this.options.mcpPrompt?.().trim", "this.options.mcpPrompt", "this.options.todoStore?.promptSection",
  "this.options.todoPrompt", "sections.join"
]);
function audit(node: ts.Node, file: ts.SourceFile): void {
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText(file);
    const pureArrayChain = ts.isPropertyAccessExpression(node.expression)
      && ["join", "slice", "filter", "trim"].includes(node.expression.name.text)
      && (ts.isArrayLiteralExpression(node.expression.expression) || ts.isParenthesizedExpression(node.expression.expression)
        || ts.isCallExpression(node.expression.expression));
    assert.ok(calls.has(name) || pureArrayChain, `Unexpected extracted call: ${name}`);
  }
  if (ts.isNewExpression(node)) assert.ok(["TypeError", "RangeError"].includes(node.expression.getText(file)));
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  ts.forEachChild(node, (child) => audit(child, file));
}
for (const node of [...selected, ...helpers]) audit(node, todo);
audit(extension, agent);
const code = [
  ...limits,
  ...helpers.map((node) => node.getText(todo)),
  "class FixtureStore {",
  ...selected.map((node) => node.getText(todo)),
  "}",
  `class Prompt { ${extension.getText(agent)} }`,
  "({ store: FixtureStore.prototype, prompt: Prompt.prototype });"
].join("\n");
interface Item { content: string; status: "pending" | "in_progress" | "completed" }
interface Store {
  initialize(): Promise<void>;
  refresh?(): Promise<void>;
  useSession(sessionId: string): Promise<void>;
  replace(items: readonly unknown[]): Promise<Item[]>;
  list(): Item[];
  promptSection(): string | undefined;
}
interface Prompt {
  extensionPrompt(selection?: { skills?: string[] }, runId?: string): Promise<string | undefined>;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture() {
  const files = new Map<string, string>();
  let reads = 0, sequence = 0;
  const fs = {
    async readFile(file: string) {
      reads += 1;
      if (!files.has(file)) throw new Error("missing or unreadable fixture file");
      return files.get(file)!;
    },
    async writeFile(file: string, content: string) { files.set(file, content); },
    async rename(from: string, to: string) {
      assert.ok(files.has(from));
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async rm(file: string) { files.delete(file); }
  };
  const extracted = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }), {
    fs, path: { join: (...parts: string[]) => parts.join("/") },
    agentDir: (workspace: string) => workspace,
    ensureAgentDirs: async () => {},
    randomUUID: () => String(++sequence)
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as { store: Store; prompt: Prompt };
  const makeStore = (sessionId: string): Store => Object.assign(Object.create(extracted.store) as Store, {
    items: [], loaded: false, commitQueue: Promise.resolve(), workspaceRoot: "workspace", sessionId
  });
  const prompt = (store?: Store, fallback?: () => string | undefined): Prompt => Object.assign(Object.create(extracted.prompt) as Prompt, {
    options: { todoStore: store, todoPrompt: fallback },
    skillPrompt: async () => undefined
  });
  return { files, makeStore, prompt, reads: () => reads };
}
const initial: Item[] = [{ content: "Original plan", status: "pending" }];
const replacement: Item[] = [{ content: "CLI replacement", status: "in_progress" }];

test("next prompt observes another same-session store's replace and clear", async () => {
  const f = fixture(), resident = f.makeStore("S"), cli = f.makeStore("S");
  await cli.replace(initial);
  await resident.initialize();
  await cli.replace(replacement);
  assert.deepEqual(clone(resident.list()), initial, "no watcher or incidental refresh");
  const before = f.reads();
  assert.match((await f.prompt(resident).extensionPrompt()) ?? "", /CLI replacement/);
  assert.equal(f.reads(), before + 1, "one read at prompt assembly");
  for (let i = 0; i < 100; i += 1) { resident.list(); resident.promptSection(); }
  assert.equal(f.reads(), before + 1, "cached projections add no reads");
  await cli.replace([]);
  assert.equal(await f.prompt(resident).extensionPrompt(), undefined);
  assert.deepEqual(clone(resident.list()), []);
});

test("different sessions stay separate and switching changes the refresh source", async () => {
  const f = fixture(), resident = f.makeStore("S"), other = f.makeStore("T");
  await resident.replace(initial);
  await resident.initialize();
  await other.replace(replacement);
  assert.match((await f.prompt(resident).extensionPrompt()) ?? "", /Original plan/);
  await resident.useSession("T");
  await other.replace([{ content: "New T plan", status: "completed" }]);
  await resident.useSession("T"); // Same-ID focus remains a no-op; prompt still refreshes.
  assert.match((await f.prompt(resident).extensionPrompt()) ?? "", /New T plan/);
  assert.doesNotMatch(resident.promptSection() ?? "", /Original plan/);
});

test("fallback and absent store preserve prompt behavior without storage reads", async () => {
  const f = fixture();
  assert.equal(await f.prompt(undefined, () => "  fallback plan  ").extensionPrompt(), "fallback plan");
  assert.equal(await f.prompt().extensionPrompt(), undefined);
  assert.equal(f.reads(), 0);
});

test("refresh retains read normalization, empty-on-read-failure, and write validation", async () => {
  const f = fixture(), resident = f.makeStore("S");
  await resident.replace(initial);
  await resident.initialize();
  for (const invalid of [[{ content: "", status: "pending" }], [{ content: "bad", status: "done" }], new Array(1)]) {
    const before = f.files.get("workspace/todos/S.json");
    await assert.rejects(resident.replace(invalid));
    assert.equal(f.files.get("workspace/todos/S.json"), before);
  }
  f.files.set("workspace/todos/S.json", JSON.stringify({ items: [
    { content: "x".repeat(501), status: "pending" }, { content: "bad", status: "done" }, null
  ] }));
  await f.prompt(resident).extensionPrompt();
  assert.deepEqual(clone(resident.list()), [{ content: "x".repeat(500), status: "pending" }]);
  for (const raw of ["{broken", "{}"]) {
    f.files.set("workspace/todos/S.json", raw);
    assert.equal(await f.prompt(resident).extensionPrompt(), undefined);
  }
  await resident.replace(initial);
  f.files.delete("workspace/todos/S.json");
  assert.equal(await f.prompt(resident).extensionPrompt(), undefined);
});

test("refresh is confined to shared prompt assembly, not the streaming loop", () => {
  const callOwners: Record<string, string[]> = { baseSystemPrompt: [], extensionPrompt: [], refresh: [] };
  for (const member of agentClass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (name in callOwners) callOwners[name]!.push(member.name.getText(agent));
      }
      ts.forEachChild(node, visit);
    };
    visit(member);
  }
  assert.deepEqual(callOwners.baseSystemPrompt, ["retry", "runTurn"]);
  assert.deepEqual(callOwners.extensionPrompt, ["baseSystemPrompt"]);
  assert.deepEqual(callOwners.refresh, ["extensionPrompt"]);
});
