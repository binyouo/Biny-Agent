/** 自动收集回归用例；每个文件独立进程和数据目录，避免手工清单漏项或重复执行。 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let mode;
let prefix;
let shard;
let reportPath;
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
const allSuites = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts") && name.startsWith(prefix ?? ""))
  .filter((name) => mode !== "--standard" || !name.endsWith("-e2e.test.ts"))
  .filter((name) => mode !== "--e2e" || name.endsWith("-e2e.test.ts"))
  .sort();
if (!allSuites.length) throw new Error(`No test files match ${[mode, prefix].filter(Boolean).join(" ") || "the request"}.`);
const suites = shard ? allSuites.filter((_suite, index) => index % shard.total === shard.index - 1) : allSuites;
if (list) {
  console.log(JSON.stringify(suites));
} else {
  const results = [];
  try {
    for (const [index, suite] of suites.entries()) {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-test-suite-"));
      console.log(`[${index + 1}/${suites.length}] ${suite}`);
      const started = performance.now();
      try {
        const code = await new Promise((resolve, reject) => {
          // 用绝对 loader URL，测试派生的 CLI 即使切到临时工作区也能继承 execArgv。
          const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join("tests", suite)], {
            cwd: root,
            env: { ...process.env, BINY_AGENT_DIR: agentDir },
            stdio: "inherit"
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
        });
        results.push({ file: suite, durationMs: performance.now() - started, exitCode: code });
        if (code !== 0) {
          process.exitCode = code;
          break;
        }
      } finally {
        await new Promise((resolve, reject) => {
          const cleanup = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "tests/helpers/memoryOwnerCleanup.ts"), agentDir], {
            cwd: root, env: { ...process.env, BINY_AGENT_DIR: agentDir }, stdio: "inherit"
          });
          cleanup.once("error", reject);
          cleanup.once("exit", code => code === 0 ? resolve() : reject(new Error("Test memory owner cleanup failed.")));
        });
        await rm(agentDir, { recursive: true, force: true });
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
