import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, realpathSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changedFilesBetween, checkResults, createPlan, resolveComparison } from "./ci-test-plan.mjs";

function fixture(t, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "biny-ci-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "src/utils/format.ts": "export const format = () => 'ok';",
    "src/utils/other.ts": "export const other = true;",
    "src/desktop/view.ts": "export { format } from '../utils/format.js';",
    "tests/view.test.ts": "import { format } from '../src/desktop/view.js';",
    "tests/other.test.ts": "import '../src/utils/other.js';",
    "tests/source.test.ts": "import { readFileSync as read } from 'node:fs'; read('src/utils/format.ts');",
    "tests/process-e2e.test.ts": "import { spawn } from 'node:child_process';",
    "tests/helpers/loader.ts": "export const load = (p: string) => import(p);",
    "tests/dynamic.test.ts": "import './helpers/loader.js';",
    ...extra
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  return root;
}

test("source changes select transitive consumers and opaque tests, not unrelated pure tests", async t => {
  const plan = await createPlan(fixture(t), ["src/utils/format.ts"]);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.standard, ["dynamic.test.ts", "source.test.ts", "view.test.ts"]);
  assert.deepEqual(plan.e2e, ["process-e2e.test.ts"]);
  assert.equal(plan.windows, true);
  assert.equal(plan.windowsPackage, false);
});

test("temporary directory writers do not turn their consumers into global tests", async t => {
  const root = fixture(t, {
    "tests/helpers/temp.ts": "import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'; export const clean = rm;",
    "tests/temporary.test.ts": "import './helpers/temp.js'; import '../src/utils/other.js';"
  });
  assert.ok(!(await createPlan(root, ["src/utils/format.ts"])).standard.includes("temporary.test.ts"));
  assert.ok((await createPlan(root, ["src/utils/other.ts"])).standard.includes("temporary.test.ts"));
});

test("literal file reads track source inputs while unknown reads stay conservative", async t => {
  const root = fixture(t, {
    "tests/url-reader.test.ts": "import { readFileSync as read } from 'node:fs'; read(new URL('../src/utils/other.ts', import.meta.url), 'utf8');",
    "tests/unknown-reader.test.ts": "import { readFile } from 'node:fs/promises'; readFile(process.env.SOURCE!, 'utf8');",
    "tests/escaped-reader.test.ts": "import { readFileSync } from 'node:fs'; const read = readFileSync; read(process.env.SOURCE!);"
  });
  const format = await createPlan(root, ["src/utils/format.ts"]);
  assert.ok(!format.standard.includes("url-reader.test.ts"));
  for (const file of ["unknown-reader.test.ts", "escaped-reader.test.ts"]) assert.ok(format.standard.includes(file));
  const other = await createPlan(root, ["src/utils/other.ts"]);
  assert.ok(other.standard.includes("url-reader.test.ts"));
  assert.ok(!other.standard.includes("source.test.ts"));
});

test("filesystem promise namespaces track literal reads and temporary writers", async t => {
  const root = fixture(t, {
    "tests/named-promises.test.ts": "import { promises as fs } from 'node:fs'; fs.readFile('src/utils/other.ts');",
    "tests/namespace-promises.test.ts": "import * as fs from 'node:fs/promises'; fs.readFile('src/utils/other.ts');",
    "tests/namespace-writer.test.ts": "import * as fs from 'node:fs/promises'; fs.mkdir('/tmp/fixture'); fs.writeFile('/tmp/fixture/file', 'data');"
  });
  const format = await createPlan(root, ["src/utils/format.ts"]);
  for (const file of ["named-promises.test.ts", "namespace-promises.test.ts", "namespace-writer.test.ts"]) assert.ok(!format.standard.includes(file));
  const other = await createPlan(root, ["src/utils/other.ts"]);
  for (const file of ["named-promises.test.ts", "namespace-promises.test.ts"]) assert.ok(other.standard.includes(file));
});

for (const code of [
  "fs.readFile(process.env.PATH_TO_SOURCE!);",
  "const read = fs.readFile; read(process.env.PATH_TO_SOURCE!);",
  "const name = process.env.METHOD!; fs[name]('source');",
  "fs.copyFile('src/utils/format.ts', '/tmp/fixture');",
  "function load(fs: any) { return fs.readFile(process.env.PATH_TO_SOURCE); }"
]) {
  test(`unbounded filesystem namespace use stays conservative: ${code}`, async t => {
    const root = fixture(t, { "tests/namespace-unknown.test.ts": `import * as fs from 'node:fs/promises'; ${code}` });
    assert.ok((await createPlan(root, ["src/utils/other.ts"])).standard.includes("namespace-unknown.test.ts"));
  });
}

test("literal reads through a symlink track the target source", async t => {
  const root = fixture(t, { "tests/symlink-reader.test.ts": "import * as fs from 'node:fs/promises'; fs.readFile('tests/source-link');" });
  symlinkSync(path.join(root, "src/utils/format.ts"), path.join(root, "tests/source-link"));
  const format = await createPlan(root, ["src/utils/format.ts"]);
  const other = await createPlan(root, ["src/utils/other.ts"]);
  assert.ok(format.standard.includes("symlink-reader.test.ts"));
  assert.ok(!other.standard.includes("symlink-reader.test.ts"));
});

test("literal reads through a symlink outside the repository stay conservative", async t => {
  const root = fixture(t, { "tests/external-link.test.ts": "import { readFileSync } from 'node:fs'; readFileSync('tests/external-link');" });
  const outside = mkdtempSync(path.join(os.tmpdir(), "biny-ci-external-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "source.ts"), "export const value = 1;");
  symlinkSync(path.join(outside, "source.ts"), path.join(root, "tests/external-link"));
  assert.ok((await createPlan(root, ["src/utils/other.ts"])).standard.includes("external-link.test.ts"));
});

test("directory inputs include their source descendants, including the repository root", async t => {
  const root = fixture(t, {
    "tests/root-reader.test.ts": "import { readdirSync } from 'node:fs'; readdirSync('.');",
    "tests/directory-reader.test.ts": "import { readdirSync } from 'node:fs'; readdirSync('src/desktop');"
  });
  const unrelated = await createPlan(root, ["src/utils/other.ts"]);
  assert.ok(unrelated.standard.includes("root-reader.test.ts"));
  assert.ok(!unrelated.standard.includes("directory-reader.test.ts"));
  const desktop = await createPlan(root, ["src/desktop/view.ts"]);
  assert.ok(desktop.standard.includes("directory-reader.test.ts"));
});

test("literal createRequire calls preserve local edges without globally selecting package consumers", async t => {
  const root = fixture(t, {
    "src/utils/package.ts": "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); export const value = load('external-package');",
    "tests/package.test.ts": "import '../src/utils/package.js';",
    "tests/required.test.ts": "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('../src/utils/format.js');",
    "tests/inline-required.test.ts": "import { createRequire } from 'node:module'; createRequire(import.meta.url).resolve('../src/utils/format.js');"
  });
  const format = await createPlan(root, ["src/utils/format.ts"]);
  assert.ok(!format.standard.includes("package.test.ts"));
  for (const file of ["required.test.ts", "inline-required.test.ts"]) assert.ok(format.standard.includes(file));
  const other = await createPlan(root, ["src/utils/other.ts"]);
  for (const file of ["package.test.ts", "required.test.ts", "inline-required.test.ts"]) assert.ok(!other.standard.includes(file));
  assert.ok((await createPlan(root, ["src/utils/package.ts"])).standard.includes("package.test.ts"));
});

for (const code of [
  "const load = createRequire(import.meta.url); load(process.env.MODULE!);",
  "const load = createRequire(import.meta.url); const escaped = load; escaped('../src/utils/format.js');",
  "const factory = createRequire; factory(import.meta.url)('../src/utils/format.js');",
  "export function loader() { return createRequire(import.meta.url); }",
  "const load = createRequire(import.meta.url); load('/tmp/another-module.js');",
  "const load = createRequire(import.meta.url); load.resolve('../src/utils/format.js', { paths: ['/another/package'] });",
  "const load = createRequire('/another/package/index.js'); load('./unknown.js');"
]) {
  test(`unresolved require ownership stays conservative: ${code}`, async t => {
    const root = fixture(t, { "tests/unknown-require.test.ts": `import { createRequire } from 'node:module'; ${code}` });
    assert.ok((await createPlan(root, ["src/utils/other.ts"])).standard.includes("unknown-require.test.ts"));
  });
}

test("working-directory changes keep relative file reads conservative", async t => {
  const root = fixture(t, {
    "tests/chdir.test.ts": "import { readFileSync } from 'node:fs'; process.chdir(process.env.DIRECTORY!); readFileSync('src/utils/format.ts');"
  });
  assert.ok((await createPlan(root, ["src/utils/other.ts"])).standard.includes("chdir.test.ts"));
});

test("external plugin and temporary-owner inputs retain ordinary source dependencies", async t => {
  const root = fixture(t, {
    "src/extensions/plugins.ts": "import '../utils/other.js'; export const load = (filePath: string) => import(pathToFileURL(filePath).href);",
    "tests/plugins.test.ts": "import '../src/extensions/plugins.js';",
    "tests/helpers/memoryOwnerCleanup.ts": "import { readFile } from 'node:fs/promises'; import '../../src/utils/other.js'; export const clean = (file: string) => readFile(file);",
    "tests/owner.test.ts": "import './helpers/memoryOwnerCleanup.js';"
  });
  const unrelated = await createPlan(root, ["src/utils/format.ts"]);
  for (const file of ["plugins.test.ts", "owner.test.ts"]) assert.ok(!unrelated.standard.includes(file));
  const dependency = await createPlan(root, ["src/utils/other.ts"]);
  for (const file of ["plugins.test.ts", "owner.test.ts"]) assert.ok(dependency.standard.includes(file));
  assert.ok((await createPlan(root, ["src/extensions/plugins.ts"])).standard.includes("plugins.test.ts"));
  // 声明只覆盖已有的外部插件入口；新增动态入口仍须保守处理。
  writeFileSync(path.join(root, "src/extensions/plugins.ts"), "export const load = (input: string) => import(input);");
  assert.ok((await createPlan(root, ["src/utils/format.ts"])).standard.includes("plugins.test.ts"));
});

test("renderer selection follows fixture dependencies and unknown consumers", async t => {
  const root = fixture(t, { "tests/fixtures/memory-disclosure/main.tsx": "import '../../../src/desktop/view.js';" });
  assert.equal((await createPlan(root, ["src/utils/format.ts"])).renderer, true);
  assert.equal((await createPlan(root, ["src/utils/other.ts"])).renderer, false);
  writeFileSync(path.join(root, "tests/fixtures/memory-disclosure/main.tsx"), "import('../../helpers/loader.js');");
  assert.equal((await createPlan(root, ["src/utils/other.ts"])).renderer, true);
});

test("selected execution catches the same injected runtime and file-input faults as the full fixture", async t => {
  const root = fixture(t, {
    "package.json": '{"type":"module"}',
    "tests/view.test.ts": "import assert from 'node:assert/strict'; import { format } from '../src/desktop/view.js'; assert.equal(format(), 'ok');",
    "tests/source.test.ts": "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.match(readFileSync(new URL('../src/utils/format.ts', import.meta.url), 'utf8'), /'ok'/);"
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = files => {
    try {
      execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", ...files.map(file => `tests/${file}`)],
        { cwd: root, env, stdio: "pipe", timeout: 20_000 });
      return { status: 0, output: "" };
    } catch (error) {
      if (error.status !== 1) throw error;
      return { status: error.status, output: error.stdout.toString() };
    }
  };
  const full = await createPlan(root, [], { full: true });
  assert.equal(run(full.standard).status, 0);
  writeFileSync(path.join(root, "src/utils/format.ts"), "export const format = () => 'broken';");
  const selected = await createPlan(root, ["src/utils/format.ts"]);
  assert.ok(!selected.standard.includes("other.test.ts"));
  for (const files of [selected.standard, full.standard]) {
    const result = run(files);
    assert.equal(result.status, 1);
    for (const file of ["view.test.ts", "source.test.ts"]) assert.ok(result.output.includes(file));
    assert.match(result.output, /AssertionError|ERR_ASSERTION/u);
  }
});

test("test-only changes select the changed test and its consumers", async t => {
  const root = fixture(t, { "tests/reuse.test.ts": "import './other.test.js';" });
  const plan = await createPlan(root, ["tests/other.test.ts"]);
  assert.deepEqual(plan.standard, ["other.test.ts", "reuse.test.ts"]);
  assert.deepEqual(plan.e2e, []);
  assert.equal(plan.build, false);
  assert.equal(plan.windows, false);
  assert.equal(plan.windowsPackage, false);
});

for (const file of ["windows-security.test.ts", "runtime-host-lock.test.ts", "runtime-host-connection-options.test.ts",
  "runtime-host-lifecycle.test.ts", "desktop-host-startup-e2e.test.ts"]) {
  test(`Windows regression changes retain platform validation: ${file}`, async t => {
    const root = fixture(t, { [`tests/${file}`]: "export {};" });
    const plan = await createPlan(root, [`tests/${file}`]);
    assert.equal(plan.windows, true);
    assert.equal(plan.windowsPackage, false);
  });
}

test("test files invoked as subprocess fixtures retain their calling regressions", async t => {
  const root = fixture(t, {
    "tests/direct-driver.test.ts": "import { spawn } from 'node:child_process'; spawn('node', ['tests/other.test.ts']);",
    "tests/computed-driver.test.ts": "import { spawn } from 'node:child_process'; for (const suite of ['other']) spawn('node', [`tests/${suite}.test.ts`]);"
  });
  const plan = await createPlan(root, ["tests/other.test.ts"]);
  assert.deepEqual(plan.standard, ["computed-driver.test.ts", "direct-driver.test.ts", "other.test.ts"]);
});

test("ordinary labels do not create dependencies on equally named test files", async t => {
  const root = fixture(t, {
    "tests/labels.test.ts": "const section = 'other'; const feature = 'view';",
    "tests/joined-driver.test.ts": "import { spawn } from 'node:child_process'; for (const suite of ['other']) spawn('node', ['tests/' + suite + '.test.ts']);"
  });
  const testChange = await createPlan(root, ["tests/other.test.ts"]);
  assert.deepEqual(testChange.standard, ["joined-driver.test.ts", "other.test.ts"]);
  const sourceChange = await createPlan(root, ["src/utils/other.ts"]);
  assert.ok(sourceChange.standard.includes("other.test.ts"));
  assert.ok(sourceChange.standard.includes("joined-driver.test.ts"));
  assert.ok(!sourceChange.standard.includes("labels.test.ts"));
});

test("documentation keeps the static gate but selects no runtime lanes", async t => {
  const plan = await createPlan(fixture(t), ["README.md", "docs/CONFIGURATION.md"]);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.standard, []);
  assert.deepEqual(plan.e2e, []);
  for (const lane of ["build", "renderer", "windows", "windowsPackage"]) assert.equal(plan[lane], false);
});

for (const file of ["pnpm-lock.yaml", "package.json", ".github/workflows/ci.yml", "scripts/run-tests.mjs",
  "config/electron-builder.yml", "tests/helpers/fixture-cleanup.ts",
  "src/utils/deleted.ts", "new-toolchain/input.json"]) {
  test(`full fallback includes Windows packaging for ${file}`, async t => {
    const plan = await createPlan(fixture(t), [file]);
    assert.equal(plan.full, true);
    assert.equal(plan.windowsPackage, true);
    assert.equal(plan.standard.length, 4);
    assert.equal(plan.e2e.length, 1);
    assert.ok(plan.reasons.length);
  });
}

for (const file of ["src/permission/check.ts", "src/runtime/host/protocol.ts", "src/session/store.ts",
  "src/session/localReferences.ts", "src/extensions/skillDiscovery.ts", "src/config/schema.ts",
  "src/agent/AgentSession.ts", "src/utils/secrets.ts", "src/utils/windowsSecurity.ts"]) {
  test(`shared source uses dependency coverage and retains opaque tests and E2E: ${file}`, async t => {
    const root = fixture(t, { [file]: "export const value = true;", "tests/core.test.ts": `import '../${file}';` });
    const plan = await createPlan(root, [file]);
    assert.equal(plan.full, false);
    assert.deepEqual(plan.standard, ["core.test.ts", "dynamic.test.ts"]);
    assert.deepEqual(plan.e2e, ["process-e2e.test.ts"]);
    assert.equal(plan.build, true);
    assert.equal(plan.windows, true);
    assert.equal(plan.windowsPackage, false);
  });
}

test("explicit full run selects everything even without changes", async t => {
  const plan = await createPlan(fixture(t), [], { full: true });
  assert.equal(plan.full, true);
  assert.equal(plan.standard.length, 4);
  assert.equal(plan.windowsPackage, true);
});

test("uncovered source and unresolved relative imports widen to full", async t => {
  const root = fixture(t, { "src/utils/new.ts": "export const value = 1;" });
  assert.equal((await createPlan(root, ["src/utils/new.ts"])).full, true);
  writeFileSync(path.join(root, "tests/view.test.ts"), "import '../src/missing.js';");
  assert.equal((await createPlan(root, ["src/utils/format.ts"])).full, true);
});

test("runtime imports retain dependency edges while erased types stay in the static gate", async t => {
  const root = fixture(t, {
    "tests/typed.test.ts": "import type { Value } from '../src/utils/format.js';",
    "tests/typed-named.test.ts": "import { type Value } from '../src/utils/format.js';",
    "tests/typed-expression.test.ts": "type Value = import('../src/utils/format.js').Value;",
    "tests/typed-export.test.ts": "export type { Value } from '../src/utils/format.js';",
    "tests/typed-named-export.test.ts": "export { type Value } from '../src/utils/format.js';",
    "tests/mixed.test.ts": "import { type Value, format } from '../src/utils/format.js'; format();",
    "tests/require-import.test.ts": "import format = require('../src/utils/format.js');",
    "tests/literal.test.ts": "await import('../src/utils/format.js');"
  });
  const plan = await createPlan(root, ["src/utils/format.ts"]);
  for (const file of ["typed.test.ts", "typed-expression.test.ts", "typed-export.test.ts"]) assert.ok(!plan.standard.includes(file));
  // 内联 type 修饰符在部分编译配置下保留模块加载，仍按运行依赖处理。
  for (const file of ["typed-named.test.ts", "typed-named-export.test.ts"]) assert.ok(plan.standard.includes(file));
  assert.ok(plan.standard.includes("mixed.test.ts"));
  assert.ok(plan.standard.includes("require-import.test.ts"));
  assert.ok(plan.standard.includes("literal.test.ts"));
});

// Git fixtures below also exercise rename/deletion and cumulative comparison.
function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function history(t) {
  const root = fixture(t);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "CI fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "src/utils/format.ts"), "export const format = () => 'updated';");
  git(root, "commit", "-am", "cancelled run");
  const cancelled = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "tests/other.test.ts"), "// second change\n");
  git(root, "commit", "-am", "current run");
  return { root, base, cancelled, head: git(root, "rev-parse", "HEAD") };
}

test("cancelled and failed pushes remain in the next comparison; PR success is not a main baseline", async t => {
  const { root, base, cancelled, head } = history(t);
  const comparison = await resolveComparison(root, "push", {}, { GITHUB_REF_NAME: "main", GITHUB_RUN_ID: "9" }, async () => [
    { id: 9, head_sha: head, head_branch: "main", event: "push", conclusion: "success" },
    { id: 8, head_sha: cancelled, head_branch: "main", event: "push", conclusion: "cancelled" },
    { id: 7, head_sha: cancelled, head_branch: "main", event: "push", conclusion: "failure" },
    { id: 6, head_sha: cancelled, head_branch: "main", event: "pull_request", conclusion: "success" },
    { id: 5, head_sha: base, head_branch: "main", event: "push", conclusion: "success" }
  ]);
  assert.equal(comparison.base, base);
  assert.deepEqual(changedFilesBetween(root, comparison.base, comparison.head), ["src/utils/format.ts", "tests/other.test.ts"]);
});

test("PR comparison uses the current base without inheriting main validation debt", async t => {
  const { root, base } = history(t);
  mkdirSync(path.join(root, "benchmarks"));
  writeFileSync(path.join(root, "benchmarks/changed.ts"), "// unverified main input");
  git(root, "add", "benchmarks/changed.ts");
  git(root, "commit", "-m", "main validation debt");
  const parent = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-b", "feature", base);
  writeFileSync(path.join(root, "tests/view.test.ts"), "import '../src/desktop/view.js'; // PR change");
  git(root, "commit", "-am", "feature");
  const feature = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  git(root, "merge", "--no-ff", "feature", "-m", "merge fixture");
  const event = { pull_request: { head: { sha: feature }, base: { ref: "main", sha: parent } } };
  for (const fetchRuns of [
    async () => [{ id: 1, head_sha: base, head_branch: "main", event: "push", conclusion: "success" }],
    async () => [],
    async () => { throw new Error("API unavailable"); }
  ]) {
    const comparison = await resolveComparison(root, "pull_request", event, {}, fetchRuns);
    assert.equal(comparison.base, parent);
    assert.equal(comparison.head, git(root, "rev-parse", "HEAD"));
    const changes = changedFilesBetween(root, comparison.base, comparison.head);
    assert.deepEqual(changes, ["tests/view.test.ts"]);
    const plan = await createPlan(root, changes);
    assert.equal(plan.full, false);
    assert.deepEqual(plan.standard, ["view.test.ts"]);
    assert.deepEqual(plan.e2e, []);
    for (const lane of ["build", "renderer", "windows", "windowsPackage"]) assert.equal(plan[lane], false);
  }
  event.pull_request.head.sha = base;
  await assert.rejects(resolveComparison(root, "pull_request", event, {}, async () => []), /merge result/u);
  event.pull_request.head.sha = feature;
  event.pull_request.base.sha = base;
  await assert.rejects(resolveComparison(root, "pull_request", event, {}, async () => []), /merge result/u);
});

test("PR plans include dependency changes introduced by the merge result", async t => {
  const { root, base } = history(t);
  const parent = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-b", "feature", base);
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  git(root, "add", "package.json");
  git(root, "commit", "-m", "dependency change");
  const feature = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  git(root, "merge", "--no-ff", "feature", "-m", "merge fixture");
  const comparison = await resolveComparison(root, "pull_request", {
    pull_request: { head: { sha: feature }, base: { ref: "main", sha: parent } }
  }, {}, async () => []);
  assert.equal(comparison.base, parent);
  const plan = await createPlan(root, changedFilesBetween(root, comparison.base, comparison.head));
  assert.equal(plan.full, true);
  assert.match(plan.reasons.join(" "), /package.json/u);
});

for (const [files, expectedShards] of [
  [["README.md"], [1]],
  [["tests/view.test.ts"], [1]],
  [["tests/view.test.ts", "tests/other.test.ts"], [1, 2]],
  [["package.json"], [1, 2, 3, 4]]
]) {
  test(`plan command emits a complete matrix for ${files.join(", ")}`, async t => {
    const { root: temporaryRoot, head } = history(t);
    const root = realpathSync(temporaryRoot);
    mkdirSync(path.join(root, "scripts"));
    for (const name of ["ci-test-plan.mjs", "run-tests.mjs"]) {
      copyFileSync(new URL(name, import.meta.url), path.join(root, "scripts", name));
    }
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(root, "node_modules"), "dir");
    for (const file of files) writeFileSync(path.join(root, file), file === "package.json" ? "{}" : "// changed");
    git(root, "add", "--", ...files);
    git(root, "commit", "-m", "selected change");
    const output = path.join(root, "outputs");
    execFileSync(process.execPath, [path.join(root, "scripts/ci-test-plan.mjs"), "--base", head], {
      cwd: root, env: { ...process.env, GITHUB_OUTPUT: output }, stdio: "pipe", timeout: 15_000
    });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    const shards = JSON.parse(outputs.shards);
    assert.deepEqual(shards, expectedShards);
    const plan = JSON.parse(readFileSync(path.join(root, ".ci/plan.json"), "utf8"));
    assert.equal(outputs.standard, String(plan.standard.length > 0));
    const selected = shards.flatMap(shard => JSON.parse(execFileSync(process.execPath, [
      path.join(root, "scripts/run-tests.mjs"), "--standard", "--plan=.ci/plan.json", `--shard=${shard}/${shards.length}`, "--list"
    ], { cwd: root, encoding: "utf8", timeout: 15_000 })));
    assert.deepEqual(selected.sort(), plan.standard);
    assert.equal(new Set(selected).size, selected.length);
  });
}

test("large standard plans use eight shards without gaps or duplicates", t => {
  const { root: temporaryRoot, head } = history(t);
  const root = realpathSync(temporaryRoot);
  mkdirSync(path.join(root, "scripts"));
  for (const name of ["ci-test-plan.mjs", "run-tests.mjs"]) copyFileSync(new URL(name, import.meta.url), path.join(root, "scripts", name));
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(root, "node_modules"), "dir");
  for (let index = 0; index < 395; index += 1) writeFileSync(path.join(root, `tests/scale-${index}.test.ts`), "");
  writeFileSync(path.join(root, "package.json"), "{}");
  git(root, "add", "--", "tests", "package.json");
  git(root, "commit", "-m", "large test set");
  const output = path.join(root, "outputs");
  const plan = (eventName = "pull_request") => {
    writeFileSync(output, "");
    execFileSync(process.execPath, [path.join(root, "scripts/ci-test-plan.mjs"), "--base", head], {
      cwd: root, env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_OUTPUT: output }, stdio: "pipe", timeout: 20_000
    });
    const line = readFileSync(output, "utf8").split("\n").find(entry => entry.startsWith("shards="));
    return JSON.parse(line.slice("shards=".length));
  };
  assert.deepEqual(plan(), [1, 2, 3, 4], "399 files retain four shards");
  writeFileSync(path.join(root, "tests/scale-395.test.ts"), "");
  git(root, "add", "--", "tests/scale-395.test.ts");
  git(root, "commit", "-m", "cross shard threshold");
  assert.deepEqual(plan("push"), [1, 2, 3, 4], "push verification retains four shards");
  const shards = plan();
  assert.deepEqual(shards, [1, 2, 3, 4, 5, 6, 7, 8]);
  const planPath = path.join(root, ".ci/plan.json");
  const actualPlan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(actualPlan.standard.length, 400);
  for (const timings of [{}, Object.fromEntries(actualPlan.standard.map((name, index) => [name, (index + 1) * 13]))]) {
    writeFileSync(planPath, JSON.stringify({ ...actualPlan, timings }));
    const selected = shards.flatMap(shard => JSON.parse(execFileSync(process.execPath, [
      path.join(root, "scripts/run-tests.mjs"), "--standard", "--plan=.ci/plan.json", `--shard=${shard}/${shards.length}`, "--list"
    ], { cwd: root, encoding: "utf8", timeout: 15_000 })));
    assert.deepEqual(selected.sort(), actualPlan.standard);
    assert.equal(new Set(selected).size, selected.length);
  }
});

test("missing history, wrong-branch success, rewritten history and API failure request full validation", async t => {
  const { root, base } = history(t);
  const env = { GITHUB_REF_NAME: "main" };
  for (const runs of [[],
    [{ id: 1, head_sha: base, head_branch: "other", event: "push", conclusion: "success" }],
    [{ id: 1, head_sha: "0".repeat(40), head_branch: "main", event: "push", conclusion: "success" }]]) {
    const result = await resolveComparison(root, "push", {}, env, async () => runs);
    assert.equal(result.base, undefined);
    assert.match(result.reason, /no successful ancestor/u);
  }
  const result = await resolveComparison(root, "push", {}, env, async () => { throw new Error("API unavailable"); });
  assert.equal(result.base, undefined);
  assert.match(result.reason, /API unavailable/u);
  git(root, "checkout", "-b", "old-main", base);
  writeFileSync(path.join(root, "src/utils/other.ts"), "export const old = true;");
  git(root, "commit", "-am", "rewritten commit");
  const rewritten = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  const diverged = await resolveComparison(root, "push", {}, env, async () => [
    { id: 2, head_sha: rewritten, head_branch: "main", event: "push", conclusion: "success" }
  ]);
  assert.equal(diverged.base, undefined);
});

test("manual and scheduled runs force full while retaining timing history", async t => {
  const { root, base } = history(t);
  for (const event of ["workflow_dispatch", "schedule"]) {
    const result = await resolveComparison(root, event, {}, { GITHUB_REF_NAME: "main" }, async () => [
      { id: 1, head_sha: base, head_branch: "main", event: "push", conclusion: "success" }
    ]);
    assert.equal(result.full, true);
    assert.equal(result.runId, 1);
  }
});

test("renames retain both old and new paths, forcing coverage of the removed dependency", async t => {
  const { root, head } = history(t);
  renameSync(path.join(root, "src/utils/format.ts"), path.join(root, "src/utils/renamed.ts"));
  git(root, "add", ".");
  git(root, "commit", "-m", "rename");
  const files = changedFilesBetween(root, head);
  assert.deepEqual(files, ["src/utils/format.ts", "src/utils/renamed.ts"]);
  assert.equal((await createPlan(root, files)).full, true);
});

test("Validate accepts only planned skips and rejects failed, cancelled, missing or skipped required lanes", async t => {
  const plan = await createPlan(fixture(t), ["docs/README.md"]);
  const needs = Object.fromEntries(["plan", "static", "test", "e2e", "build", "renderer", "windows"].map(lane => [
    lane, { result: ["plan", "static"].includes(lane) ? "success" : "skipped" }
  ]));
  assert.doesNotThrow(() => checkResults(plan, needs));
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.throws(() => checkResults(plan, { ...needs, static: { result } }), /static/u);
  }
  assert.throws(() => checkResults({ ...plan, standard: ["view.test.ts"] }, needs), /test/u);
  assert.throws(() => checkResults(plan, { ...needs, test: { result: "failure" } }), /test/u);
});

test("Validate rejects static-gated skips and fail-fast cancellations in a full plan", async t => {
  const plan = await createPlan(fixture(t), [], { full: true });
  const needs = Object.fromEntries(["plan", "static", "test", "e2e", "build", "renderer", "windows"].map(lane => [lane, { result: "success" }]));
  assert.doesNotThrow(() => checkResults(plan, needs));
  const blocked = Object.fromEntries(Object.keys(needs).map(lane => [lane, {
    result: lane === "plan" ? "success" : lane === "static" ? "failure" : "skipped"
  }]));
  assert.throws(() => checkResults(plan, blocked), /static/u);
  for (const lane of ["test", "e2e", "build", "renderer", "windows"]) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      assert.throws(() => checkResults(plan, { ...needs, [lane]: { result } }), new RegExp(lane, "u"));
    }
  }
});

test("Validate command fails for a static-blocked run or cancelled test matrix", t => {
  const root = fixture(t);
  const planFile = path.join(root, "plan.json");
  writeFileSync(planFile, JSON.stringify({ standard: ["view.test.ts"], e2e: ["process-e2e.test.ts"], build: true, renderer: true, windows: true }));
  const needs = Object.fromEntries(["plan", "static", "test", "e2e", "build", "renderer", "windows"].map(lane => [lane, { result: "success" }]));
  const validate = results => execFileSync(process.execPath, [fileURLToPath(new URL("./ci-test-plan.mjs", import.meta.url)),
    "--check-results", "--output", planFile], { env: { ...process.env, NEEDS_JSON: JSON.stringify(results) }, stdio: "pipe" });
  assert.match(validate(needs).toString(), /All selected validation lanes passed/u);
  for (const [lane, result] of [["static", "failure"], ["test", "cancelled"]]) {
    const results = { ...needs, [lane]: { result } };
    if (lane === "static") for (const dependent of ["test", "e2e", "build", "renderer", "windows"]) results[dependent] = { result: "skipped" };
    assert.throws(() => validate(results), error => error.status === 1 && error.stderr.toString().includes(`${lane}: expected success, received ${result}`));
  }
});

test("workflow gates selected lanes on static checks and retains full-run and packaging gates", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.ok("workflow_dispatch" in workflow.on);
  assert.ok(workflow.on.schedule.length);
  const outputs = { test: "standard", e2e: "e2e", build: "build", renderer: "renderer", windows: "windows" };
  for (const [lane, output] of Object.entries(outputs)) {
    assert.deepEqual(workflow.jobs[lane].needs, ["plan", "static"]);
    assert.equal(workflow.jobs[lane].if, `needs.plan.outputs.${output} == 'true'`);
    assert.ok(workflow.jobs.validate.needs.includes(lane));
  }
  assert.equal(workflow.jobs.plan.needs, undefined);
  assert.equal(workflow.jobs.static.needs, undefined);
  assert.equal(workflow.jobs.test.strategy["max-parallel"], 8);
  assert.equal(workflow.jobs.plan.outputs.shards, "${{ steps.plan.outputs.shards }}");
  assert.equal(workflow.jobs.test.strategy.matrix.shard, "${{ fromJSON(needs.plan.outputs.shards) }}");
  assert.ok(workflow.jobs.test.steps.some(step => step.run?.includes("--shard=${{ matrix.shard }}/${{ strategy.job-total }}")));
  assert.equal(workflow.jobs.test.strategy["fail-fast"], "${{ github.event_name == 'pull_request' }}");
  assert.equal(workflow.jobs.validate.if, "${{ always() }}");
  assert.ok(workflow.jobs.validate.needs.includes("static"));
  const windows = workflow.jobs.windows.steps;
  assert.equal(windows.find(step => step.name === "Package Windows application").if, "needs.plan.outputs.windows_package == 'true'");
  assert.equal(windows.find(step => step.with?.name === "windows-x64").if, "needs.plan.outputs.windows_package == 'true'");
  assert.equal(windows.find(step => step.name === "Validate built Electron Host").if, undefined);
  for (const lane of ["test", "e2e"]) {
    assert.ok(workflow.jobs[lane].steps.some(step => step.run?.includes("--plan=.ci/plan.json")));
    assert.ok(workflow.jobs[lane].steps.some(step => step.with?.name === "ci-plan"));
  }
});

test("Vite SSR consumers stay selected when an ordinary import already proves coverage", async t => {
  const root = fixture(t, {
    "tests/vite-view.test.ts": "import { createServer } from 'vite'; const server = await createServer(); await server.ssrLoadModule('/src/desktop/view.ts');",
    "tests/helpers/vite-loader.ts": "import { createServer } from 'vite'; export const load = async (file: string) => (await createServer()).ssrLoadModule(file);",
    "tests/vite-helper.test.ts": "import { load } from './helpers/vite-loader.js'; await load('/src/desktop/view.ts');",
    "tests/vite-dynamic.test.ts": "const { createServer } = await import('vite'); await (await createServer()).ssrLoadModule('/src/desktop/view.ts');"
  });
  const plan = await createPlan(root, ["src/desktop/view.ts"]);
  assert.equal(plan.full, false, "exercise selective planning rather than the no-consumer fallback");
  assert.ok(plan.standard.includes("view.test.ts"), "ordinary static consumer remains selected");
  assert.ok(plan.standard.includes("vite-view.test.ts"), "Vite SSR reads the same changed source and must remain selected");
  assert.ok(plan.standard.includes("vite-helper.test.ts"), "Vite opacity propagates through shared helpers");
  assert.ok(plan.standard.includes("vite-dynamic.test.ts"), "literal dynamic Vite imports also load source outside the import graph");
  assert.ok(!plan.standard.includes("other.test.ts"), "unrelated pure tests remain unselected");
  const testOnly = await createPlan(root, ["tests/other.test.ts"]);
  assert.equal(testOnly.full, false);
  assert.deepEqual(testOnly.standard, ["other.test.ts"], "test-only changes do not select unrelated Vite consumers");
  const docsOnly = await createPlan(root, ["README.md"]);
  assert.equal(docsOnly.full, false);
  assert.deepEqual(docsOnly.standard, [], "documentation-only changes remain static-only");
});
