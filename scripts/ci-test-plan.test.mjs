import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

test("test-only changes select the changed test and its consumers", async t => {
  const root = fixture(t, { "tests/reuse.test.ts": "import './other.test.js';" });
  const plan = await createPlan(root, ["tests/other.test.ts"]);
  assert.deepEqual(plan.standard, ["other.test.ts", "reuse.test.ts"]);
  assert.deepEqual(plan.e2e, []);
  assert.equal(plan.build, false);
  assert.equal(plan.windowsPackage, false);
});

test("test files invoked as subprocess fixtures retain their calling regressions", async t => {
  const root = fixture(t, {
    "tests/direct-driver.test.ts": "import { spawn } from 'node:child_process'; spawn('node', ['tests/other.test.ts']);",
    "tests/computed-driver.test.ts": "import { spawn } from 'node:child_process'; for (const suite of ['other']) spawn('node', [`tests/${suite}.test.ts`]);"
  });
  const plan = await createPlan(root, ["tests/other.test.ts"]);
  assert.deepEqual(plan.standard, ["computed-driver.test.ts", "direct-driver.test.ts", "other.test.ts"]);
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
  "src/config/schema.ts", "src/agent/AgentSession.ts", "src/utils/secrets.ts", "src/utils/windowsSecurity.ts"]) {
  test(`existing shared authority forces full despite a resolvable test: ${file}`, async t => {
    const root = fixture(t, { [file]: "export const value = true;", "tests/core.test.ts": `import '../${file}';` });
    const plan = await createPlan(root, [file]);
    assert.equal(plan.full, true);
    assert.equal(plan.windowsPackage, true);
    assert.equal(plan.standard.length, 5);
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

test("literal dynamic imports and type imports retain dependency edges", async t => {
  const root = fixture(t, {
    "tests/typed.test.ts": "import type { Value } from '../src/utils/format.js';",
    "tests/literal.test.ts": "await import('../src/utils/format.js');"
  });
  const plan = await createPlan(root, ["src/utils/format.ts"]);
  assert.ok(plan.standard.includes("typed.test.ts"));
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

test("PR comparison includes unverified base changes and validates the merge head", async t => {
  const { root, base } = history(t);
  git(root, "checkout", "-b", "feature", base);
  writeFileSync(path.join(root, "src/utils/other.ts"), "export const other = false;");
  git(root, "commit", "-am", "feature");
  const feature = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  git(root, "merge", "--no-ff", "feature", "-m", "merge fixture");
  const event = { pull_request: { head: { sha: feature }, base: { ref: "main" } } };
  const comparison = await resolveComparison(root, "pull_request", event, {}, async () => [
    { id: 1, head_sha: base, head_branch: "main", event: "push", conclusion: "success" }
  ]);
  assert.equal(comparison.base, base);
  assert.deepEqual(changedFilesBetween(root, comparison.base, comparison.head), ["src/utils/format.ts", "src/utils/other.ts", "tests/other.test.ts"]);
  const parent = git(root, "rev-parse", "HEAD^1");
  const latest = await resolveComparison(root, "pull_request", event, {}, async () => [
    { id: 2, head_sha: parent, head_branch: "main", event: "push", conclusion: "success" }
  ]);
  assert.equal(latest.base, parent);
  event.pull_request.head.sha = base;
  await assert.rejects(resolveComparison(root, "pull_request", event, {}, async () => []), /merge result/u);
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
