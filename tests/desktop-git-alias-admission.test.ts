/** Extract production members; every filesystem/Git operation is a pure in-memory seam. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = readFileSync(path.join(process.cwd(), "src/desktop/electron/main/DesktopProjectService.ts"), "utf8");
const ast = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopProjectService")!;
const names = new Set(["gitMutations", "gitWorktreeMutations", "gitMutationAdmission", "acquireGitMutation", "gitAdmissionRead", "switchProjectBranch", "createProjectBranch", "projectGitRemote", "commitProjectFiles", "initializeProjectGit", "listProjectBranches", "listGitBranches", "projectGitStatus", "gitStatus"]);
const diagnostics = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && ["isGitRepositoryMissing", "gitErrorText"].includes(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
assert.equal(ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["isGitRepositoryMissing", "gitErrorText"].includes(node.name?.text ?? "")).length, 2);
const emitted = ts.transpileModule(`${diagnostics} class Service { ${klass.members.filter(node => node.name && names.has(node.name.getText(ast))).map(node => node.getText(ast)).join("\n")} }; globalThis.Service = Service;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.ok(!/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(/u.test(emitted.outputText));
interface Project { id: string; path: string }
interface Service {
  requireProject(id: string): Project;
  switchProjectBranch(id: string, name: string): Promise<void>;
  createProjectBranch(id: string, name: string): Promise<void>;
  projectGitRemote(id: string, action: "push" | "pull"): Promise<unknown>;
  commitProjectFiles(id: string, input: { message: string; paths: string[]; revision: string }): Promise<unknown>;
  initializeProjectGit(id: string): Promise<unknown>;
  projectGitStatus(id: string): Promise<{ revision: string }>;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const aliases = new Map<string, string>([["/alias", "/repo"], ["/alias-sub", "/repo/sub"]]);
  const repos = new Map<string, string>([["/repo", "/repo/.git"], ["/linked", "/repo/.git/worktrees/linked"], ["/repo/nested", "/repo/nested/.git"]]);
  const calls: Array<{ cwd: string; command: string; waitForClose?: boolean }> = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  let readHold: { kind: string; value: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const beforeRead = async (kind: string, value: string) => {
    if (readHold?.kind === kind && readHold.value === value) { const block = readHold; readHold = undefined; block.entered.resolve(); await block.release.promise; }
  };
  const canonical = (value: string) => aliases.get(value) ?? value;
  const repository = (cwd: string) => [...repos.keys()].sort((a, b) => b.length - a.length).find(root => cwd === root || cwd.startsWith(root + "/"));
  let held: { match: (cwd: string, command: string) => boolean; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let failure: string | undefined;
  let injectedError: Error | undefined;
  let identityOutput: string | undefined;
  const runGit = async (input: string, args: string[], _timeout?: number, waitForClose?: boolean) => {
    const cwd = canonical(input), command = args.join(" "); calls.push({ cwd: input, command, waitForClose });
    if (held?.match(cwd, command)) { const block = held; held = undefined; block.entered.resolve(); await block.release.promise; }
    if (failure === command) { failure = undefined; throw injectedError ?? new Error("fixture identity failure"); }
    const root = repository(cwd);
    if (command === "init") { repos.set(cwd, cwd + "/.git"); return { stdout: "", stderr: "" }; }
    if (!root) throw new Error("not a git repository");
    if (command === "rev-parse --absolute-git-dir" && identityOutput !== undefined) return { stdout: identityOutput, stderr: "" };
    if (command === "rev-parse --absolute-git-dir" || command === "rev-parse --git-dir") return { stdout: repos.get(root)! + "\n", stderr: "" };
    if (command === "rev-parse --show-toplevel") return { stdout: root + "\n", stderr: "" };
    if (args[0] === "for-each-ref") return { stdout: "existing\0*\n", stderr: "" };
    if (args[0] === "status") return { stdout: args.includes("-z") ? " M a.txt\0" : "", stderr: "" };
    return { stdout: "current", stderr: "" };
  };
  const context = createContext({ setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id), path, os: { tmpdir: () => "/synthetic/tmp" },
    normalizeBranchName: (name: string) => name.trim(), assertValidBranchName: async () => {},
    assertGitRepository: async (project: Project) => { await runGit(project.path, ["rev-parse", "--git-dir"]); },
    assertCleanGitWorkspace: async () => {}, directoryExists: async (value: string) => { await beforeRead("directory", value); return true; },
    isWorkspaceAccessDenied: () => false,
    createHash: () => ({ update: () => ({ digest: () => "revision" }) }), gitOutput: async () => "HEAD",
    fs: { realpath: async (value: string) => { await beforeRead("realpath", value); if (failure === "realpath" || (failure === "gitdir realpath" && value.endsWith("/.git"))) { failure = undefined; throw new Error("fixture realpath failure"); } return canonical(value); }, mkdtemp: async () => "/synthetic/tmp/paths", writeFile: async () => {}, rm: async () => {} }, runGit
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const service = new (context.Service as new () => Service)();
  service.requireProject = id => ({ id, path: id });
  return { service, calls, aliases, repos,
    expireReads() { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
    pendingTimers() { return timers.size; },
    holdRead(kind: string, value: string) { const block = { kind, value, entered: deferred(), release: deferred() }; readHold = block; return block; },
    identity(value: string) { identityOutput = value; }, fail(command: string, error?: Error) { failure = command; injectedError = error; },
    hold(command: string, cwd?: string) { const block = { match: (p: string, c: string) => c === command && (!cwd || p === cwd), entered: deferred(), release: deferred() }; held = block; return block; }
  };
}
const actions = {
  switch: (s: Service, id: string) => s.switchProjectBranch(id, "existing"),
  create: (s: Service, id: string) => s.createProjectBranch(id, "new"),
  push: (s: Service, id: string) => s.projectGitRemote(id, "push"),
  pull: (s: Service, id: string) => s.projectGitRemote(id, "pull"),
  commit: (s: Service, id: string) => s.commitProjectFiles(id, { message: "selected", paths: ["a.txt"], revision: "revision" })
};
const commands = { switch: "switch existing", create: "switch -c new", push: "push", pull: "pull --ff-only", commit: "--literal-pathspecs commit --only -m selected --pathspec-from-file=/synthetic/tmp/paths/paths --pathspec-file-nul" };
for (const [firstName, first] of Object.entries(actions)) for (const [secondName, second] of Object.entries(actions)) for (const [owner, alias] of [["/repo", "/alias"], ["/alias", "/repo"]]) {
  test(`${firstName} at ${owner} excludes alias ${secondName} without releasing owner`, async () => {
    const f = fixture(), hold = f.hold(commands[firstName as keyof typeof commands]);
    const pending = first(f.service, owner); await hold.entered.promise;
    try { await assert.rejects(second(f.service, alias), /Git 操作进行中/u); await assert.rejects(second(f.service, alias), /Git 操作进行中/u); }
    finally { hold.release.resolve(); await pending; }
    await second(f.service, alias);
  });
}
for (const directory of ["/repo/sub", "/alias-sub"]) test(`root push excludes branch change in ${directory}`, async () => {
  const f = fixture(), hold = f.hold("push"); const pending = actions.push(f.service, "/repo"); await hold.entered.promise;
  try { await assert.rejects(actions.switch(f.service, directory), /Git 操作进行中/u); }
  finally { hold.release.resolve(); await pending; }
});
for (const directory of ["/linked", "/repo/nested"]) test(`independent worktree/repository ${directory} proceeds during push`, async () => {
  const f = fixture(), hold = f.hold("push", "/repo"); const pending = actions.push(f.service, "/repo"); await hold.entered.promise;
  try { await actions.switch(f.service, directory); } finally { hold.release.resolve(); await pending; }
});
for (const directory of ["/repo/sub", "/alias-sub"]) test(`canonical cwd retains subdirectory and root restriction: ${directory}`, async () => {
  const f = fixture(); await actions.switch(f.service, directory);
  assert.ok(f.calls.some(call => call.command === "switch existing" && call.cwd === "/repo/sub"));
  await assert.rejects(actions.push(f.service, directory), /根目录/u);
  await assert.rejects(actions.commit(f.service, directory), /根目录/u);
  assert.equal(f.calls.some(call => call.command === "push" || call.command.startsWith("--literal-pathspecs add")), false);
});
for (const failure of ["realpath", "rev-parse --absolute-git-dir"]) test(`${failure} failure closes admission, never falls back`, async () => {
  const f = fixture(); f.fail(failure); await assert.rejects(actions.switch(f.service, "/alias"), /fixture/u);
  assert.equal(f.calls.some(call => call.command === "switch existing"), false);
  await actions.switch(f.service, "/repo"); await actions.switch(f.service, "/alias");
});
for (const [first, second] of [["/fresh", "/fresh/sub"], ["/fresh/sub", "/fresh"]]) test(`init admission is ordered ${first} then ${second}`, async () => {
  const f = fixture(), hold = f.hold("init", first); const pending = f.service.initializeProjectGit(first); await hold.entered.promise;
  const next = f.service.initializeProjectGit(second); const outcome = next.then(() => "ok", error => String(error));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.some(call => call.cwd === second), false, "second discovery must not cross init gate");
  hold.release.resolve(); await pending;
  if (first === "/fresh") assert.match(await outcome, /已经是 Git 仓库/u); else assert.equal(await outcome, "ok");
});
test("ordinary admission cannot cross pending ancestor init", async () => {
  const f = fixture(), hold = f.hold("init", "/fresh"); const pending = f.service.initializeProjectGit("/fresh"); await hold.entered.promise;
  const next = actions.switch(f.service, "/fresh/sub"); const outcome = next.then(() => "ok", error => String(error));
  await Promise.resolve(); await Promise.resolve(); assert.equal(f.calls.some(call => call.cwd === "/fresh/sub"), false);
  hold.release.resolve(); await pending; const result = await outcome;
  assert.ok(result === "ok" || result.includes("Git 操作进行中"));
});
test("trailing whitespace and newline in worktree identity are not trimmed", async () => {
  const f = fixture(); f.repos.set("/weird", "/weird/.git \n\t"); f.aliases.set("/weird-alias", "/weird");
  const hold = f.hold("push", "/weird"); const pending = actions.push(f.service, "/weird"); await hold.entered.promise;
  try { await assert.rejects(actions.switch(f.service, "/weird-alias"), /Git 操作进行中/u); }
  finally { hold.release.resolve(); await pending; }
});
for (const directory of ["/repo/sub", "/alias-sub"]) test(`subdirectory branch owner excludes root push: ${directory}`, async () => {
  const f = fixture(), hold = f.hold("switch existing"); const pending = actions.switch(f.service, directory); await hold.entered.promise;
  try { await assert.rejects(actions.push(f.service, "/repo"), /Git 操作进行中/u); }
  finally { hold.release.resolve(); await pending; }
});
test("init holds unrelated admission only until initialization and identity discovery finish", async () => {
  const f = fixture(), hold = f.hold("init", "/fresh"); const pending = f.service.initializeProjectGit("/fresh"); await hold.entered.promise;
  const next = actions.switch(f.service, "/linked");
  try { await Promise.resolve(); await Promise.resolve(); assert.equal(f.calls.some(call => call.cwd === "/linked"), false); }
  finally { hold.release.resolve(); await pending; await next; }
  assert.ok(f.calls.some(call => call.cwd === "/linked" && call.command === "switch existing"));
});
for (const command of ["init", "rev-parse --absolute-git-dir"]) test(`init ${command} failure releases admission without retry`, async () => {
  const f = fixture(); f.fail(command); await assert.rejects(f.service.initializeProjectGit("/fresh"), /fixture/u);
  assert.equal(f.calls.filter(call => call.command === "init").length, 1);
  await actions.switch(f.service, "/linked");
  if (command === "init") await f.service.initializeProjectGit("/fresh");
  else { await assert.rejects(f.service.initializeProjectGit("/fresh"), /已经是 Git 仓库/u); assert.equal(f.calls.filter(call => call.command === "init").length, 1); }
});
test("queued discovery continues after preceding identity failure", async () => {
  const f = fixture(), hold = f.hold("rev-parse --absolute-git-dir", "/repo"); f.fail("rev-parse --absolute-git-dir");
  const rejected = assert.rejects(actions.switch(f.service, "/repo"), /fixture/u); await hold.entered.promise;
  const next = actions.switch(f.service, "/linked"); hold.release.resolve(); await rejected; await next;
  await actions.switch(f.service, "/repo");
});
test("all operation commands use the frozen canonical project even if project lookup changes", async () => {
  const f = fixture(); let reads = 0;
  f.service.requireProject = () => ({ id: "selected", path: ++reads === 1 ? "/alias" : "/linked" });
  await actions.push(f.service, "selected"); assert.equal(reads, 1);
  assert.ok(f.calls.length > 1); assert.ok(f.calls.every(call => call.cwd === "/repo"));
});

for (const output of ["", "relative/.git\n"]) test(`invalid identity ${JSON.stringify(output)} never admits mutation`, async () => {
  const f = fixture(); f.identity(output); await assert.rejects(actions.switch(f.service, "/repo"), /身份/u);
  assert.equal(f.calls.some(call => call.command === "switch existing"), false);
});
test("gitdir realpath failure closes admission rather than using unchecked output", async () => {
  const f = fixture(); f.fail("gitdir realpath"); await assert.rejects(actions.switch(f.service, "/repo"), /realpath/u);
  assert.equal(f.calls.some(call => call.command === "switch existing"), false);
  await actions.switch(f.service, "/alias");
});

for (const step of ["directory", "cwd", "identity", "gitdir", "init probe"] as const) test(`timed-out ${step} read cannot resume admission or disturb a new owner`, async () => {
  const f = fixture();
  const block = step === "directory" ? f.holdRead("directory", "/alias")
    : step === "cwd" ? f.holdRead("realpath", "/alias")
    : step === "gitdir" ? f.holdRead("realpath", "/repo/.git")
    : f.hold(step === "init probe" ? "rev-parse --git-dir" : "rev-parse --absolute-git-dir", "/repo");
  const timedOut = assert.rejects(step === "init probe" ? f.service.initializeProjectGit("/alias") : actions.switch(f.service, "/alias"), /超时/u);
  await block.entered.promise;
  const fast = actions.switch(f.service, "/linked");
  f.expireReads(); await timedOut; await fast;
  const ownerHold = f.hold("push", "/repo"); const owner = actions.push(f.service, "/repo"); await ownerHold.entered.promise;
  try {
    const before = f.calls.length; block.release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, before, "late read must not run subsequent discovery/init/mutation");
    await assert.rejects(actions.switch(f.service, "/alias"), /Git 操作进行中/u);
  } finally { ownerHold.release.resolve(); await owner; }
  await actions.switch(f.service, "/alias"); assert.equal(f.pendingTimers(), 0);
});
test("read timeout releases FIFO admission in enqueue order", async () => {
  const f = fixture(), block = f.holdRead("directory", "/repo");
  const first = assert.rejects(actions.switch(f.service, "/repo"), /超时/u); await block.entered.promise;
  const second = actions.switch(f.service, "/linked"), third = actions.switch(f.service, "/repo/nested");
  f.expireReads(); await first; await second; await third;
  const order = f.calls.filter(call => call.command === "rev-parse --absolute-git-dir").map(call => call.cwd);
  assert.deepEqual(order, ["/linked", "/repo/nested"]);
  block.release.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.some(call => call.cwd === "/repo"), false);
});
test("init subprocess cannot be timed out by the read deadline or release admission while pending", async () => {
  const f = fixture(); f.aliases.set("/fresh-alias", "/fresh");
  const block = f.hold("init", "/fresh"); const first = f.service.initializeProjectGit("/fresh-alias"); await block.entered.promise;
  assert.equal(f.pendingTimers(), 0, "init must not be wrapped in a read timer");
  assert.equal(f.calls.find(call => call.command === "init")?.waitForClose, true);
  const duplicate = f.service.initializeProjectGit("/fresh").then(() => "ok", error => String(error));
  const fast = actions.switch(f.service, "/linked");
  f.expireReads(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.some(call => call.cwd === "/linked"), false);
  assert.equal(f.calls.filter(call => call.command === "init").length, 1);
  block.release.resolve(); await first; assert.match(await duplicate, /已经是 Git 仓库/u); await fast;
  assert.equal(f.calls.filter(call => call.command === "init").length, 1);
  assert.equal(f.pendingTimers(), 0);
});
test("late rejected missing-repository probe cannot initiate a repository", async () => {
  const f = fixture(), block = f.hold("rev-parse --git-dir", "/fresh");
  const first = assert.rejects(f.service.initializeProjectGit("/fresh"), /超时/u); await block.entered.promise;
  f.expireReads(); await first; await actions.switch(f.service, "/linked");
  block.release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.command === "init"), false); assert.equal(f.repos.has("/fresh"), false);
  await f.service.initializeProjectGit("/fresh");
});

for (const [name, action] of Object.entries(actions)) test(`missing-repository admission preserves existing Chinese error for ${name}`, async () => {
  const f = fixture();
  // Pure equivalent of tests/desktop.test.ts:1310: switch a valid name in a non-Git project.
  await assert.rejects(action(f.service, "/not-a-repository"), /不是 Git/u);
  assert.equal(f.calls.some(call => call.cwd === "/not-a-repository" && !call.command.startsWith("rev-parse")), false);
  f.repos.set("/not-a-repository", "/not-a-repository/.git");
  await action(f.service, "/not-a-repository");
});
for (const stderr of ["fatal: not a git repository (or any of the parent directories): .git\n", "致命错误：不是 git 仓库（或者任何父目录）：.git\n"]) test(`missing-repository stderr retains classification: ${stderr.trim()}`, async () => {
  const f = fixture(); f.fail("rev-parse --absolute-git-dir", Object.assign(new Error("Command failed: git rev-parse"), { code: 128, stderr }));
  await assert.rejects(actions.switch(f.service, "/repo"), /不是 Git/u); await actions.switch(f.service, "/alias");
});
for (const [code, message, stderr] of [
  ["ETIMEDOUT", "spawn git ETIMEDOUT", ""],
  ["EACCES", "spawn git EACCES", "Permission denied"],
  ["EPERM", "spawn git EPERM", "Operation not permitted"],
  [128, "Command failed: git rev-parse", "fatal: bad config line 1 in file .git/config"],
  [128, "Command failed: git rev-parse", "fatal: invalid gitfile format: .git"]
]) test(`non-missing ${code}/${message}/${stderr} stays unchanged and releases admission`, async () => {
  const f = fixture(), original = Object.assign(new Error(String(message)), { code, stderr });
  f.fail("rev-parse --absolute-git-dir", original);
  await assert.rejects(actions.switch(f.service, "/repo"), error => error === original);
  assert.equal(f.calls.some(call => call.command === "switch existing"), false);
  await actions.switch(f.service, "/alias");
});
