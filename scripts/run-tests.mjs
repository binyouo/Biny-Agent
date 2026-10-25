/** 自动收集回归用例；每个文件独立进程和数据目录，避免手工清单漏项或重复执行。 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let mode;
let prefix;
let shard;
let reportPath;
let planPath;
let list = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--standard" || arg === "--e2e") {
    if (mode) throw new Error("Choose either --standard or --e2e once.");
    mode = arg;
  } else if (arg.startsWith("--shard=")) {
    const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/u.exec(arg);
    if (shard || !match) throw new Error("Use one --shard=index/total with 1 <= index <= total.");
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
      throw new Error("Use one --shard=index/total with 1 <= index <= total.");
    }
    shard = { index, total };
  } else if (arg.startsWith("--plan=")) {
    if (planPath || !arg.slice(7)) throw new Error("Use one --plan=path with a nonempty path.");
    planPath = path.resolve(arg.slice(7));
  } else if (arg.startsWith("--report=")) {
    if (reportPath || !arg.slice(9)) throw new Error("Use one --report=path with a nonempty path.");
    reportPath = path.resolve(arg.slice(9));
  } else if (arg === "--list") {
    list = true;
  } else if (arg.startsWith("--")) {
    throw new Error(`Unknown test runner option: ${arg}`);
  } else {
    if (prefix !== undefined) throw new Error("Only one test file prefix is supported.");
    prefix = arg;
  }
}
let allSuites = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts") && name.startsWith(prefix ?? ""))
  .filter((name) => mode !== "--standard" || !name.endsWith("-e2e.test.ts"))
  .filter((name) => mode !== "--e2e" || name.endsWith("-e2e.test.ts"))
  .sort();
if (!allSuites.length) throw new Error(`No test files match ${[mode, prefix].filter(Boolean).join(" ") || "the request"}.`);
let timings = {};
if (planPath) {
  if (!mode || prefix !== undefined) throw new Error("A plan requires --standard or --e2e, without a prefix.");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.head && plan.head !== execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()) {
    throw new Error("Test plan belongs to a different checkout commit.");
  }
  const selected = plan[mode === "--standard" ? "standard" : "e2e"];
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
    || selected.some(file => !allSuites.includes(file))) throw new Error("Plan contains missing, duplicate, or wrong-lane tests.");
  allSuites = [...selected].sort();
  timings = plan.timings ?? {};
}
let suites = allSuites;
if (shard) {
  const known = allSuites.map(file => timings[file]).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!known.length) {
    suites = allSuites.filter((_suite, index) => index % shard.total === shard.index - 1);
  } else {
    const typical = known[Math.floor(known.length / 2)];
    const weight = file => Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : typical;
    const groups = Array.from({ length: Math.min(shard.total, allSuites.length) }, () => ({ files: [], duration: 0 }));
    // 长任务先入队；所有分片使用同一份计划中的历史耗时，避免重叠或漏项。
    for (const file of [...allSuites].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"))) {
      const group = groups.reduce((best, candidate) => candidate.duration < best.duration ? candidate : best);
      group.files.push(file);
      group.duration += weight(file);
    }
    suites = groups[shard.index - 1]?.files ?? [];
  }
}
if (list) {
  console.log(JSON.stringify(suites));
} else {
  const results = [];
  try {
    for (const [index, suite] of suites.entries()) {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-test-suite-"));
      console.log(`[${index + 1}/${suites.length}] ${suite}`);
      const started = performance.now();
      let testMs = 0;
      let code = 1;
      try {
        code = await new Promise((resolve, reject) => {
          // 用绝对 loader URL，测试派生的 CLI 即使切到临时工作区也能继承 execArgv。
          const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join("tests", suite)], {
            cwd: root,
            env: { ...process.env, BINY_AGENT_DIR: agentDir },
            stdio: "inherit"
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
        });
        testMs = performance.now() - started;
        if (code !== 0) {
          process.exitCode = code;
          break;
        }
      } finally {
        const cleanupStarted = performance.now();
        let cleanupFailed = true;
        try {
          await new Promise((resolve, reject) => {
            const cleanup = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "tests/helpers/memoryOwnerCleanup.ts"), agentDir], {
              cwd: root, env: { ...process.env, BINY_AGENT_DIR: agentDir }, stdio: "inherit"
            });
            cleanup.once("error", reject);
            cleanup.once("exit", code => code === 0 ? resolve() : reject(new Error("Test memory owner cleanup failed.")));
          });
          await rm(agentDir, { recursive: true, force: true });
          cleanupFailed = false;
        } finally {
          const cleanupMs = performance.now() - cleanupStarted;
          results.push({ file: suite, testMs, cleanupMs, durationMs: performance.now() - started,
            exitCode: cleanupFailed ? (code || 1) : code });
        }
      }
    }
  } finally {
    if (reportPath) {
      await writeFile(reportPath, JSON.stringify({
        shard: shard ?? null,
        totalFiles: allSuites.length,
        selectedFiles: suites,
        results
      }, null, 2) + "\n");
    }
  }
}
