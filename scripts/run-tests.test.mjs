import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(repository, "scripts/run-tests.mjs");

function fixture(context, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "biny-test-runner-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "tests"));
  symlinkSync(path.join(repository, "tests/helpers"), path.join(root, "tests/helpers"), "dir");
  copyFileSync(runner, path.join(root, "scripts/run-tests.mjs"));
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, "tests", name), content);
  return root;
}

function run(root, ...args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/run-tests.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
}

const files = {
  "i.test.ts": "throw new Error('listing must not execute tests')",
  "b.test.ts": "",
  "a.test.ts": "",
  "g.test.ts": "",
  "e.test.ts": "",
  "d.test.ts": "",
  "c.test.ts": "",
  "h.test.ts": "",
  "f.test.ts": "",
  "a-e2e.test.ts": "",
  "a.txt": ""
};

test("four standard shards cover every discovered file exactly once in stable order", context => {
  const root = fixture(context, files);
  const expected = [
    ["a.test.ts", "e.test.ts", "i.test.ts"],
    ["b.test.ts", "f.test.ts"],
    ["c.test.ts", "g.test.ts"],
    ["d.test.ts", "h.test.ts"]
  ];
  const actual = expected.map((_group, index) => {
    const result = run(root, "--standard", `--shard=${index + 1}/4`, "--list");
    assert.equal(result.status, 0, result.output);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(actual, expected);
  const unsharded = run(root, "--standard", "--list");
  assert.equal(unsharded.status, 0, unsharded.output);
  assert.deepEqual(actual.flat().sort(), JSON.parse(unsharded.stdout));
  assert.equal(new Set(actual.flat()).size, 9);
});

test("listing retains prefix and E2E filters without executing any file", context => {
  const root = fixture(context, files);
  const result = run(root, "--e2e", "a", "--list");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout), ["a-e2e.test.ts"]);
  const all = run(root, "a", "--list");
  assert.equal(all.status, 0, all.output);
  assert.deepEqual(JSON.parse(all.stdout), ["a-e2e.test.ts", "a.test.ts"]);
});

for (const args of [
  ["--shard=0/4"], ["--shard=5/4"], ["--shard=1/0"], ["--shard=1.5/4"],
  ["--shard=1/4", "--shard=2/4"], ["--shard=1/9007199254740992"],
  ["--standard", "--e2e"], ["--unknown"], ["--report="], ["a", "b"]
]) {
  test(`invalid runner arguments fail before executing files: ${args.join(" ")}`, context => {
    const root = fixture(context, { "a.test.ts": "require('node:fs').writeFileSync('executed', '')" });
    const result = run(root, ...args);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(path.join(root, "executed")), false);
    assert.doesNotMatch(result.output, /\[1\//u);
  });
}

test("each real child and its descendants use an independent directory that is cleaned, with timing recorded", context => {
  const source = `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const dir = process.env.BINY_AGENT_DIR;
assert.ok(dir && existsSync(dir));
execFileSync(process.execPath, [...process.execArgv, '--eval', "require('node:assert/strict').ok(process.env.BINY_AGENT_DIR)"], { cwd: dir });
appendFileSync('executions.jsonl', JSON.stringify({ pid: process.pid, dir }) + '\\n');
`;
  const root = fixture(context, { "a.test.ts": source, "b.test.ts": source });
  const result = run(root, "--standard", "--report=timings.json");
  assert.equal(result.status, 0, result.output);
  const records = readFileSync(path.join(root, "executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].pid, records[1].pid);
  assert.notEqual(records[0].dir, records[1].dir);
  for (const record of records) assert.equal(existsSync(record.dir), false);
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  assert.equal(report.totalFiles, 2);
  assert.equal(report.shard, null);
  assert.deepEqual(report.selectedFiles, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(report.results.map(({ file, exitCode }) => ({ file, exitCode })), [
    { file: "a.test.ts", exitCode: 0 }, { file: "b.test.ts", exitCode: 0 }
  ]);
  for (const { durationMs } of report.results) assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
});

test("a failed child keeps its exit code, cleans its directory and reports only completed executions", context => {
  const root = fixture(context, {
    "a.test.ts": "require('node:fs').writeFileSync('failed-dir', process.env.BINY_AGENT_DIR); process.exit(7)",
    "b.test.ts": "require('node:fs').writeFileSync('unexpected', '')"
  });
  const result = run(root, "--report=timings.json");
  assert.equal(result.status, 7, result.output);
  assert.equal(existsSync(readFileSync(path.join(root, "failed-dir"), "utf8")), false);
  assert.equal(existsSync(path.join(root, "unexpected")), false);
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  assert.deepEqual(report.selectedFiles, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(report.results.map(({ file, exitCode }) => ({ file, exitCode })), [{ file: "a.test.ts", exitCode: 7 }]);
});

test("executing a nonempty shard runs only its selected files and reports their results", context => {
  const root = fixture(context, {
    "a.test.ts": "require('node:fs').appendFileSync('ran', 'a\\n')",
    "b.test.ts": "throw new Error('file belongs to another shard')",
    "c.test.ts": "require('node:fs').appendFileSync('ran', 'c\\n')"
  });
  const result = run(root, "--standard", "--shard=1/2", "--report=timings.json");
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(path.join(root, "ran"), "utf8"), "a\nc\n");
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  assert.deepEqual(report.shard, { index: 1, total: 2 });
  assert.equal(report.totalFiles, 3);
  assert.deepEqual(report.selectedFiles, ["a.test.ts", "c.test.ts"]);
  assert.deepEqual(report.results.map(({ file, exitCode }) => ({ file, exitCode })), [
    { file: "a.test.ts", exitCode: 0 }, { file: "c.test.ts", exitCode: 0 }
  ]);
});

test("a valid empty shard succeeds and records zero executions", context => {
  const root = fixture(context, { "a.test.ts": "throw new Error('wrong shard')" });
  const result = run(root, "--standard", "--shard=4/4", "--report=timings.json");
  assert.equal(result.status, 0, result.output);
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  assert.equal(report.totalFiles, 1);
  assert.deepEqual(report.shard, { index: 4, total: 4 });
  assert.deepEqual(report.selectedFiles, []);
  assert.deepEqual(report.results, []);
});

test("an impact plan executes only selected files and balances long suites first", context => {
  const root = fixture(context, Object.fromEntries(["a", "b", "c", "d", "e"].map(name => [
    `${name}.test.ts`, `require('node:fs').appendFileSync('ran', '${name}\\n')`
  ])));
  writeFileSync(path.join(root, "plan.json"), JSON.stringify({
    standard: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"], e2e: [],
    timings: { "a.test.ts": 100, "b.test.ts": 80, "c.test.ts": 20, "d.test.ts": 10 }
  }));
  const first = run(root, "--standard", "--plan=plan.json", "--shard=1/2", "--report=timings.json");
  assert.equal(first.status, 0, first.output);
  assert.equal(readFileSync(path.join(root, "ran"), "utf8"), "a\nd\n");
  const second = run(root, "--standard", "--plan=plan.json", "--shard=2/2", "--list");
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(JSON.parse(second.stdout), ["b.test.ts", "c.test.ts"]);
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  for (const result of report.results) {
    assert.ok(result.cleanupMs >= 0);
    assert.ok(result.testMs >= 0);
    assert.ok(result.durationMs >= result.testMs + result.cleanupMs);
  }
});

test("new files remain covered when timings are partial or unusable", context => {
  const root = fixture(context, files);
  const standard = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(name => `${name}.test.ts`);
  for (const timings of [{ "a.test.ts": 100 }, { "a.test.ts": -1, "b.test.ts": "bad" }, {}]) {
    writeFileSync(path.join(root, "plan.json"), JSON.stringify({ standard, e2e: [], timings }));
    const shards = [1, 2, 3, 4].flatMap(index => {
      const result = run(root, "--standard", "--plan=plan.json", `--shard=${index}/4`, "--list");
      assert.equal(result.status, 0, result.output);
      return JSON.parse(result.stdout);
    });
    assert.deepEqual(shards.sort(), standard);
    assert.equal(new Set(shards).size, standard.length);
  }
});

test("empty plans run nothing, while missing or mismatched selected files fail", context => {
  const root = fixture(context, { "a.test.ts": "throw new Error('unselected')" });
  writeFileSync(path.join(root, "plan.json"), JSON.stringify({ standard: [], e2e: [] }));
  assert.equal(run(root, "--standard", "--plan=plan.json").status, 0);
  for (const standard of [["gone.test.ts"], ["../escape.test.ts"], ["a.test.ts", "a.test.ts"], ["a-e2e.test.ts"]]) {
    writeFileSync(path.join(root, "plan.json"), JSON.stringify({ standard, e2e: [] }));
    const result = run(root, "--standard", "--plan=plan.json");
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.output, /\[1\//u);
  }
  assert.notEqual(run(root, "--plan=plan.json").status, 0);
  assert.notEqual(run(root, "--standard", "--plan=plan.json", "a").status, 0);
});

test("cleanup failure is reported as failure and stops subsequent suites", context => {
  const root = fixture(context, {
    "a.test.ts": "require('node:fs').writeFileSync('agent-dir', process.env.BINY_AGENT_DIR)",
    "b.test.ts": "require('node:fs').writeFileSync('unexpected', '')"
  });
  unlinkSync(path.join(root, "tests/helpers"));
  mkdirSync(path.join(root, "tests/helpers"));
  writeFileSync(path.join(root, "tests/helpers/memoryOwnerCleanup.ts"), "process.exit(4)");
  const result = run(root, "--report=timings.json");
  const agentDir = readFileSync(path.join(root, "agent-dir"), "utf8");
  context.after(() => rmSync(agentDir, { recursive: true, force: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /cleanup failed/u);
  assert.equal(existsSync(path.join(root, "unexpected")), false);
  const report = JSON.parse(readFileSync(path.join(root, "timings.json"), "utf8"));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].exitCode, 1);
});

test("a plan from another checkout commit is rejected before tests execute", context => {
  const root = fixture(context, { "a.test.ts": "throw new Error('must not execute')" });
  for (const args of [["init"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(path.join(root, "plan.json"), JSON.stringify({ head: "0".repeat(40), standard: ["a.test.ts"], e2e: [] }));
  const result = run(root, "--standard", "--plan=plan.json");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /different checkout commit/u);
  assert.doesNotMatch(result.output, /\[1\//u);
});
