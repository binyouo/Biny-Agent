/** Production Git transport extracted without starting any process. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";
const source = readFileSync(path.join(process.cwd(), "src/desktop/electron/main/DesktopProjectService.ts"), "utf8");
const ast = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const runGit = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runGit")!;
const emitted = ts.transpileModule(`${runGit.getText(ast)}; globalThis.run = runGit;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const child = new EventEmitter(); let resolve!: (value: { stdout: string; stderr: string }) => void, reject!: (reason: Error) => void;
  const execution = Object.assign(new Promise<{ stdout: string; stderr: string }>((yes, no) => { resolve = yes; reject = no; }), { child });
  const calls: unknown[] = [];
  const context = createContext({ execFileAsync: (...args: unknown[]) => { calls.push(args); return execution; }, gitInspectionEnvironment: () => ({}) });
  new Script(emitted).runInContext(context, { timeout: 1000 });
  const run = context.run as (cwd: string, args: string[], timeout: number, waitForClose?: boolean) => Promise<{ stdout: string; stderr: string }>;
  return { child, resolve, reject, run, calls };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
for (const failure of [false, true]) test(`init transport retains completion until close after ${failure ? "rejection" : "success"}`, async () => {
  const f = fixture(); let settled = false;
  const operation = f.run("/synthetic", ["init"], 10_000, true).then(value => { settled = true; return value.stdout; }, error => { settled = true; return String(error); });
  if (failure) f.reject(new Error("kill failed before close")); else f.resolve({ stdout: "initialized", stderr: "" });
  await drain(); assert.equal(settled, false); assert.equal(f.child.listenerCount("close"), 1);
  f.child.emit("close", failure ? 1 : 0, null);
  assert.equal(await operation, failure ? "Error: kill failed before close" : "initialized");
  assert.equal(f.child.listenerCount("close"), 0);
});
test("init tolerates close arriving before promise settlement", async () => {
  const f = fixture(); const operation = f.run("/synthetic", ["init"], 10_000, true);
  f.child.emit("close", 0, null); f.resolve({ stdout: "initialized", stderr: "" }); assert.equal((await operation).stdout, "initialized");
});
test("non-init transport preserves existing error settlement semantics", async () => {
  const f = fixture(); const operation = assert.rejects(f.run("/synthetic", ["rev-parse", "--git-dir"], 4_000), /read failure/u);
  f.reject(new Error("read failure")); await operation; assert.equal(f.child.listenerCount("close"), 0);
});
test("actual init admission stays owned after execFile rejection until child close", async () => {
  const klass = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopProjectService")!;
  const names = new Set(["gitMutations", "gitWorktreeMutations", "gitMutationAdmission", "gitAdmissionRead", "acquireGitMutation", "initializeProjectGit"]);
  const code = ts.transpileModule(`${runGit.getText(ast)}; class Service { ${klass.members.filter(node => node.name && names.has(node.name.getText(ast))).map(node => node.getText(ast)).join("\n")} }; globalThis.Service = Service;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const child = new EventEmitter(); let rejectInit!: (error: Error) => void, initStarted!: () => void;
  const entered = new Promise<void>(resolve => { initStarted = resolve; });
  const execution = Object.assign(new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectInit = reject; }), { child });
  const calls: string[] = [];
  const context = createContext({ path, setTimeout, clearTimeout, fs: { realpath: async (value: string) => value }, directoryExists: async () => true,
    isGitRepositoryMissing: (error: unknown) => String(error).includes("not a git repository"), gitInspectionEnvironment: () => ({}),
    execFileAsync: (_file: string, args: string[], options: { cwd: string }) => {
      calls.push(options.cwd + ":" + args.slice(4).join(" "));
      if (args.at(-1) === "init") { initStarted(); return execution; }
      const result = args.at(-1) === "--git-dir" ? Promise.reject(new Error("not a git repository")) : Promise.resolve({ stdout: options.cwd + "/.git\n", stderr: "" });
      return Object.assign(result, { child: new EventEmitter() });
    }
  });
  new Script(code).runInContext(context, { timeout: 1000 });
  const service = new (context.Service as new () => {
    requireProject(id: string): { id: string; path: string };
    initializeProjectGit(id: string): Promise<unknown>;
    acquireGitMutation(project: { id: string; path: string }): Promise<{ release(): void }>;
  })();
  service.requireProject = id => ({ id, path: id }); let settled = false;
  const first = service.initializeProjectGit("/fresh").then(() => { settled = true; return "ok"; }, error => { settled = true; return String(error); });
  await entered; rejectInit(new Error("kill failed before close")); await drain();
  assert.equal(settled, false);
  await assert.rejects(service.initializeProjectGit("/fresh"), /Git 操作进行中/u);
  const next = service.acquireGitMutation({ id: "other", path: "/other" }); await drain();
  assert.equal(calls.some(call => call.startsWith("/other:")), false);
  child.emit("close", 1, null); assert.match(await first, /kill failed before close/u); (await next).release();
  assert.equal(calls.filter(call => call.endsWith(":init")).length, 1);
});
test("synchronous execFile throw releases raw ownership and FIFO admission", async () => {
  const klass = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopProjectService")!;
  const names = new Set(["gitMutations", "gitWorktreeMutations", "gitMutationAdmission", "gitAdmissionRead", "acquireGitMutation", "initializeProjectGit"]);
  const code = ts.transpileModule(`${runGit.getText(ast)}; class Service { ${klass.members.filter(node => node.name && names.has(node.name.getText(ast))).map(node => node.getText(ast)).join("\n")} }; globalThis.Service = Service;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const child = new EventEmitter(); let initStarted!: () => void;
  const entered = new Promise<void>(resolve => { initStarted = resolve; });
  const calls: string[] = [];
  const context = createContext({ path, setTimeout, clearTimeout, fs: { realpath: async (value: string) => value }, directoryExists: async () => true,
    isGitRepositoryMissing: (error: unknown) => String(error).includes("not a git repository"), gitInspectionEnvironment: () => ({}),
    execFileAsync: (_file: string, args: string[], options: { cwd: string }) => {
      calls.push(options.cwd + ":" + args.slice(4).join(" "));
      if (args.at(-1) === "init") { initStarted(); throw new Error("synchronous spawn failure"); }
      const result = args.at(-1) === "--git-dir" ? Promise.reject(new Error("not a git repository")) : Promise.resolve({ stdout: options.cwd + "/.git\n", stderr: "" });
      return Object.assign(result, { child: new EventEmitter() });
    }
  });
  new Script(code).runInContext(context, { timeout: 1000 });
  const service = new (context.Service as new () => {
    requireProject(id: string): { id: string; path: string };
    initializeProjectGit(id: string): Promise<unknown>;
    acquireGitMutation(project: { id: string; path: string }): Promise<{ release(): void }>;
  })();
  service.requireProject = id => ({ id, path: id }); let settled = false;
  const first = service.initializeProjectGit("/fresh").then(() => { settled = true; return "ok"; }, error => { settled = true; return String(error); });
  await entered; assert.match(await first, /synchronous spawn failure/u); assert.equal(settled, true);
  const next = await service.acquireGitMutation({ id: "other", path: "/other" }); next.release();
  const recovered = await service.acquireGitMutation({ id: "fresh", path: "/fresh" }); recovered.release();
  assert.equal(child.listenerCount("close"), 0, "no child was returned to wait on");
  assert.equal(calls.filter(call => call.endsWith(":init")).length, 1);
});
