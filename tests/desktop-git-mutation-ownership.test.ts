/** Real Git mutation methods with inert Git/filesystem seams: never starts a process or reads a repository. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = readFileSync(path.join(process.cwd(), "src/desktop/electron/main/DesktopProjectService.ts"), "utf8");
const ast = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = ast.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopProjectService");
assert.equal(classes.length, 1);
const names = ["gitMutations", "switchProjectBranch", "createProjectBranch", "projectGitRemote", "commitProjectFiles", "initializeProjectGit"];
const members = names.map(name => {
  const matches = classes[0]!.members.filter(node => node.name?.getText(ast) === name);
  assert.equal(matches.length, 1); return matches[0]!.getText(ast);
});
const emitted = ts.transpileModule(`class Service { ${members.join("\n")} }; globalThis.Service = Service;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.ok(!/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(/u.test(emitted.outputText));
interface Service {
  switchProjectBranch(id: string, name: string): Promise<void>;
  createProjectBranch(id: string, name: string): Promise<void>;
  projectGitRemote(id: string, action: "push" | "pull"): Promise<unknown>;
  commitProjectFiles(id: string, input: { message: string; paths: string[]; revision: string }): Promise<unknown>;
  initializeProjectGit(id: string): Promise<unknown>;
  requireProject(id: string): { id: string; path: string };
  projectGitStatus(id: string): Promise<unknown>;
  listProjectBranches(id: string): Promise<Array<{ name: string; current?: boolean }>>;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const entered = deferred(), release = deferred();
  const calls: Array<{ cwd: string; args: string[] }> = [];
  let hold = false, held = false;
  let failure: string | undefined;
  let injectedError: Error | undefined;
  const checkpoint = async (step: string): Promise<void> => {
    if (hold && !held) { held = true; entered.resolve(); await release.promise; }
    if (failure === step) { failure = undefined; throw injectedError ?? new Error(`fixture failure: ${step}`); }
  };
  const context = createContext({ path, os: { tmpdir: () => "/synthetic/tmp" },
    normalizeBranchName: (name: string) => { if (!name.trim()) throw new Error("empty branch"); return name.trim(); },
    assertValidBranchName: async () => checkpoint("name"), assertGitRepository: async () => checkpoint("repository"),
    assertCleanGitWorkspace: async () => checkpoint("clean"), directoryExists: async () => true,
    gitErrorText: (error: unknown) => String(error), isGitRepositoryMissing: (error: unknown) => String(error).includes("not a git repository"),
    fs: { mkdtemp: async () => "/synthetic/tmp/paths", writeFile: async () => {}, rm: async () => {} },
    runGit: async (cwd: string, args: string[]) => {
      if (args.join(" ") === "rev-parse --git-dir") { await checkpoint("probe"); throw new Error("not a git repository"); }
      calls.push({ cwd, args: [...args] }); await checkpoint("command"); return { stdout: "", stderr: "" };
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const service = new (context.Service as new () => Service)();
  service.requireProject = id => ({ id, path: `/synthetic/${id}` });
  service.projectGitStatus = async () => { await checkpoint("status"); return { revision: "current", files: [{ path: "a.txt", status: " M" }] }; };
  service.listProjectBranches = async () => { await checkpoint("branches"); return [{ name: "current", current: true }, { name: "existing" }]; };
  return { service, calls, entered, release, hold() { hold = true; }, fail(step: string, error?: Error) { failure = step; injectedError = error; } };
}
const actions = {
  switch: (s: Service, id: string) => s.switchProjectBranch(id, "existing"),
  create: (s: Service, id: string) => s.createProjectBranch(id, "new"),
  push: (s: Service, id: string) => s.projectGitRemote(id, "push"),
  pull: (s: Service, id: string) => s.projectGitRemote(id, "pull"),
  commit: (s: Service, id: string) => s.commitProjectFiles(id, { message: "selected", paths: ["a.txt"], revision: "current" }),
  init: (s: Service, id: string) => s.initializeProjectGit(id)
};
const busy = /Git 操作进行中/u;
for (const [firstName, first] of Object.entries(actions)) for (const [secondName, second] of Object.entries(actions)) {
  test(`same-project ${firstName} excludes ${secondName} before asynchronous preflight`, async () => {
    const f = fixture(); f.hold(); const pending = first(f.service, "A");
    try {
      await f.entered.promise;
      await assert.rejects(second(f.service, "A"), busy);
      await assert.rejects(actions.push(f.service, "A"), busy, "rejected caller must not release the first caller's lock");
    } finally { f.release.resolve(); await pending; }
    await second(f.service, "A");
  });
}
for (const [name, first] of Object.entries(actions)) {
  test(`${name} does not lock another workspace`, async () => {
    const f = fixture(); f.hold(); const pending = first(f.service, "A");
    try { await f.entered.promise; await actions.switch(f.service, "B"); }
    finally { f.release.resolve(); await pending; }
    assert.ok(f.calls.some(call => call.cwd === "/synthetic/B" && call.args[0] === "switch"));
  });
}
for (const name of ["switch", "create"] as const) for (const step of ["name", "repository", "clean", "branches", "command"]) {
  test(`${name} releases its lock after ${step} rejection`, async () => {
    const f = fixture(); f.fail(step);
    await assert.rejects(actions[name](f.service, "A"), /fixture failure/u);
    await actions[name](f.service, "A");
    await actions.push(f.service, "A");
  });
}
for (const name of ["switch", "create"] as const) {
  test(`${name} releases after synchronous validation and absent/duplicate branch rejection`, async () => {
    const f = fixture();
    await assert.rejects(f.service[name === "switch" ? "switchProjectBranch" : "createProjectBranch"]("A", ""), /empty branch/u);
    await assert.rejects(f.service[name === "switch" ? "switchProjectBranch" : "createProjectBranch"]("A", name === "switch" ? "missing" : "existing"), /不存在|已存在/u);
    await actions.push(f.service, "A");
  });
}
test("switching to current branch retains ordinary Git invocation and releases the lock", async () => {
  const f = fixture(); await f.service.switchProjectBranch("A", "current"); await actions.push(f.service, "A");
  assert.deepEqual(f.calls.map(call => call.args), [["switch", "current"], ["push"]]);
});

for (const name of ["switch", "create"] as const) for (const code of ["ETIMEDOUT", "AbortError"]) {
  test(`${name} releases after lower-level ${code} rejection (no new cancellation API)`, async () => {
    const f = fixture(); f.fail("command", Object.assign(new Error(`fixture ${code}`), { code, name: code }));
    await assert.rejects(actions[name](f.service, "A"), new RegExp(code));
    await actions.push(f.service, "A");
  });
}
