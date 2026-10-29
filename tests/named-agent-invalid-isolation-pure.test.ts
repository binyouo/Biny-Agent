/** Actual loader/parser and dispatch resolver, with synthetic in-memory filesystem only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import type { SubagentDefinition, LoadSubagentDefinitionsOptions } from "../src/extensions/agents.js";

type DefinitionModule = typeof import("../src/extensions/agents.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/extensions/agents.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
} }).outputText;
const document = (name: string, field = "runtime: builtin", body = "Review the requested document."): string =>
  `---\nname: ${name}\ndescription: Focused review\n${field}\n---\n${body}`;

function fixture(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const directories = new Set(["/work", "/work/agents", "/work/secondary", "/global"]);
  const unreadable = new Set<string>();
  const unreadableDirectories = new Set<string>();
  const symlinks = new Set<string>();
  const writes: string[] = [];
  const missing = (): Error => Object.assign(new Error("missing synthetic path"), { code: "ENOENT" });
  const io = {
    async realpath(file: string) {
      if (directories.has(file) || files.has(file)) return file;
      throw missing();
    },
    async lstat(file: string) {
      if (directories.has(file)) return { isDirectory: () => true, isSymbolicLink: () => symlinks.has(file) };
      const content = files.get(file);
      if (content === undefined) throw missing();
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => symlinks.has(file), nlink: 1n, size: BigInt(Buffer.byteLength(content)) };
    },
    async readdir(directory: string) {
      if (unreadableDirectories.has(directory)) throw Object.assign(new Error("synthetic denied directory"), { code: "EACCES" });
      return [...files.keys()].filter(file => path.posix.dirname(file) === directory)
        .map(file => ({ name: path.posix.basename(file), isFile: () => true }));
    },
    async readFile(file: string) {
      if (unreadable.has(file)) throw Object.assign(new Error("synthetic denied file"), { code: "EACCES" });
      if (!files.has(file)) throw missing();
      return files.get(file);
    },
    async mkdir() {},
    async writeFile(file: string) { writes.push(file); },
    async unlink(file: string) { writes.push(file); }
  };
  const exported = {};
  vm.runInNewContext(compiled, {
    exports: exported, Buffer,
    require(name: string): unknown {
      if (name === "node:fs") return { promises: io };
      if (name === "node:path") return path.posix;
      if (name === "node:os") return { homedir: () => "/synthetic-home" };
      if (name === "../config/paths.js") return { globalConfigDir: () => "/config" };
      throw new Error(`Forbidden product import: ${name}`);
    }
  }, { timeout: 1000 });
  const api = exported as DefinitionModule;
  const options: LoadSubagentDefinitionsOptions = { workspaceRoot: "/work", projectPaths: ["agents"], globalRoot: "/global" };
  return { api, options, files, unreadable, unreadableDirectories, symlinks, writes,
    load: () => api.loadSubagentDefinitions(options) };
}

for (const invalid of ["runtime: builtni", "isolation: worktre"]) {
  for (const scope of ["project", "global"] as const) {
    test(`${scope} ${invalid} retains a tombstone and later healthy definitions`, async () => {
      const directory = scope === "project" ? "/work/agents" : "/global";
      const f = fixture({ [`${directory}/a.md`]: document("a"), [`${directory}/b.md`]: document("b", invalid), [`${directory}/c.md`]: document("c") });
      const definitions = await f.load();
      assert.equal(definitions.map(item => item.name).join(","), "a,b,c");
      const bad = definitions[1]!;
      assert.match(bad.invalidReason!, /Invalid subagent (runtime|isolation)/u);
      assert.match(bad.description, /^Unavailable:/u);
      assert.equal(bad.prompt, ""); assert.equal(bad.tools?.length, 0);
      assert.equal(bad.runtime, undefined); assert.equal(bad.model, undefined); assert.equal(bad.isolation, undefined);
      assert.equal(f.api.findSubagentDefinition(definitions, "c")?.name, "c");
      assert.throws(() => f.api.findSubagentDefinition(definitions, "B"), /unavailable.*b\.md.*no fallback/u);
      const prompt = f.api.buildSubagentDefinitionsPrompt(definitions);
      assert.match(prompt, /b \(.*unavailable\)/u);
      assert.match(prompt, /Fix .*b\.md/u);
      assert.equal(f.writes.length, 0);
    });
  }
  test(`${invalid} shadows a global same-name definition without changing healthy routing`, async () => {
    const f = fixture({ "/work/agents/local-name.md": document("ReviewER", invalid), "/global/reviewer.md": document("reviewer", "runtime: codex\nmodel: external"), "/global/other.md": document("other", "runtime: builtin\ntools: Read") });
    const definitions = await f.load();
    assert.equal(definitions.filter(item => item.name === "reviewer").length, 1);
    for (const name of ["reviewer", "REVIEWER", " Reviewer "]) assert.throws(() => f.api.findSubagentDefinition(definitions, name), /local-name\.md/u);
    const healthy = f.api.findSubagentDefinition(definitions, "other")!;
    assert.equal(healthy.runtime, "builtin"); assert.equal(healthy.tools?.join(","), "Read");
  });
  test(`${invalid} create stays strict and writes nothing`, async () => {
    const f = fixture({});
    await assert.rejects(f.api.createSubagentDefinition(f.options, "b", document("b", invalid), "project"), /Invalid subagent/u);
    assert.equal(f.writes.length, 0);
  });
}

test("configured-directory precedence and duplicate normalized names remain first-wins", async () => {
  const f = fixture({ "/work/agents/a.md": document("REVIEWER", "runtime: wrong"), "/work/agents/z.md": document("reviewer"), "/work/secondary/a.md": document("reviewer"), "/global/a.md": document("reviewer") });
  f.options.projectPaths.push("secondary");
  const definitions = await f.load();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]!.path, path.posix.join("agents", "a.md"));
  assert.throws(() => f.api.findSubagentDefinition(definitions, "Reviewer"), /unavailable/u);
});

test("repairing a file on the next load removes its tombstone; unrelated creation and delete remain usable", async () => {
  const f = fixture({ "/work/agents/b.md": document("b", "runtime: wrong"), "/work/agents/c.md": document("c") });
  const before = await f.load();
  assert.throws(() => f.api.findSubagentDefinition(before, "b"), /unavailable/u);
  await assert.rejects(f.api.deleteSubagentDefinition(f.options, "b"), /unavailable/u);
  assert.equal(f.writes.length, 0);
  await f.api.createSubagentDefinition(f.options, "d", document("d"), "project");
  await f.api.deleteSubagentDefinition(f.options, "c");
  assert.equal(f.writes.join(","), "/work/agents/d.md,/work/agents/c.md");
  f.files.set("/work/agents/b.md", document("b", "runtime: builtin\ntools: Read"));
  const repaired = f.api.findSubagentDefinition(await f.load(), "b")!;
  assert.equal(repaired.invalidReason, undefined); assert.equal(repaired.tools?.join(","), "Read");
});

for (const cause of ["read", "symlink", "oversize", "missing-required", "bad-frontmatter", "directory-read"] as const) {
  test(`existing ${cause} discovery handling is not broadened`, async () => {
    const file = "/work/agents/reviewer.md";
    const f = fixture({ [file]: document("reviewer"), "/global/reviewer.md": document("reviewer") });
    if (cause === "read") f.unreadable.add(file);
    if (cause === "symlink") f.symlinks.add(file);
    if (cause === "oversize") f.files.set(file, "x".repeat(32769));
    if (cause === "missing-required") f.files.set(file, "---\nname: reviewer\nruntime: wrong\n---\nbody");
    if (cause === "bad-frontmatter") f.files.set(file, "---\nnot a key value\n---\nbody");
    if (cause === "directory-read") f.unreadableDirectories.add("/work/agents");
    const selected = f.api.findSubagentDefinition(await f.load(), "reviewer")!;
    assert.equal(selected.scope, "global"); assert.equal(selected.invalidReason, undefined);
    assert.equal(f.writes.length, 0);
  });
}

test("configured project root violations remain hard failures", async () => {
  const f = fixture({});
  f.options.projectPaths = ["../escape"];
  await assert.rejects(f.load(), /stay inside workspace/u);
  f.options.projectPaths = ["agents"]; f.symlinks.add("/work/agents");
  await assert.rejects(f.load(), /symbolic links/u);
});

test("actual named-dispatch resolver rejects invalid identity before returning an execution definition", async () => {
  const text = readFileSync(path.join(root, "src/extensions/subagent.ts"), "utf8");
  const parsed = ts.createSourceFile("subagent.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "resolveSubagentDefinition");
  assert.ok(declaration);
  const f = fixture({ "/work/agents/b.md": document("b", "isolation: wrong"), "/global/b.md": document("b", "runtime: codex"), "/work/agents/c.md": document("c") });
  const context = vm.createContext({ findSubagentDefinition: f.api.findSubagentDefinition });
  vm.runInContext(ts.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 1000 });
  const resolve = vm.runInContext("resolveSubagentDefinition", context) as (options: { loadAgentDefinitions(): Promise<SubagentDefinition[]> }, name?: string) => Promise<SubagentDefinition | undefined>;
  await assert.rejects(resolve({ loadAgentDefinitions: f.load }, "b"), /unavailable.*no fallback/u);
  assert.equal((await resolve({ loadAgentDefinitions: f.load }, "c"))?.name, "c");
  assert.equal(await resolve({ loadAgentDefinitions: async () => { throw new Error("must not load unnamed"); } }), undefined);
  assert.equal(f.writes.length, 0);
});


test("an earlier valid definition keeps precedence over a later invalid duplicate", async () => {
  const f = fixture({ "/work/agents/a.md": document("reviewer"), "/work/agents/z.md": document("reviewer", "runtime: wrong"), "/global/a.md": document("reviewer", "runtime: wrong") });
  const definitions = await f.load();
  assert.equal(definitions.length, 1);
  assert.equal(f.api.findSubagentDefinition(definitions, "reviewer")?.invalidReason, undefined);
});

test("filename-derived identity remains reserved when runtime is invalid", async () => {
  const f = fixture({ "/work/agents/reviewer.md": "---\ndescription: review\nruntime: wrong\n---\nbody", "/global/a.md": document("reviewer") });
  const definitions = await f.load();
  assert.equal(definitions.length, 1);
  assert.throws(() => f.api.findSubagentDefinition(definitions, "reviewer"), /unavailable/u);
});

test("invalid identities retain the existing bounded collection budget", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 17; i++) {
    const name = `agent${String(i).padStart(2, "0")}`;
    files[`/work/agents/${name}.md`] = document(name, i === 0 ? "runtime: wrong" : "runtime: builtin");
  }
  const f = fixture(files);
  const definitions = await f.load();
  assert.equal(definitions.length, 16);
  assert.equal(f.api.findSubagentDefinition(definitions, "agent15")?.name, "agent15");
  assert.equal(f.api.findSubagentDefinition(definitions, "agent16"), undefined);
});

test("actual text reports and structured agents card expose unavailable source diagnostics", async () => {
  const f = fixture({ "/work/agents/b.md": document("b", "runtime: wrong"), "/work/agents/c.md": document("c") });
  const definitions = await f.load();
  function extract(file: string, names: string[]): string {
    const text = readFileSync(path.join(root, file), "utf8");
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
    assert.equal(declarations.length, names.length);
    return declarations.map(node => node.getText(parsed)).join("\n");
  }
  const extracted = extract("src/extensions/report.ts", ["formatSubagentAgentList", "formatSubagentAgents"])
    + "\n" + extract("src/runtime/commandCards.ts", ["buildSubagentAgentsCard", "row", "detailRow"]);
  const context = vm.createContext({ exports: {}, definitions });
  vm.runInContext(ts.transpileModule(extracted, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 1000 });
  for (const expression of ["formatSubagentAgentList(definitions)", "formatSubagentAgents(definitions).join('\\n')", "JSON.stringify(buildSubagentAgentsCard(definitions))"]) {
    const result = vm.runInContext(expression, context) as string;
    assert.match(result, /Unavailable: Invalid subagent runtime/u);
    assert.match(result, /b\.md/u);
    assert.match(result, /Focused review/u);
  }
});
