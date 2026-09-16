/** 自动收集回归用例；每个文件独立进程和数据目录，避免手工清单漏项或重复执行。 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const modes = args.filter((arg) => arg === "--standard" || arg === "--e2e");
if (modes.length > 1) throw new Error("Choose either --standard or --e2e.");
const mode = modes[0];
const prefixes = args.filter((arg) => !arg.startsWith("--"));
if (prefixes.length > 1) throw new Error("Only one test file prefix is supported.");
const prefix = prefixes[0] ?? "";
const suites = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts") && name.startsWith(prefix))
  .filter((name) => mode !== "--standard" || !name.endsWith("-e2e.test.ts"))
  .filter((name) => mode !== "--e2e" || name.endsWith("-e2e.test.ts"))
  .sort();
if (!suites.length) throw new Error(`No test files match ${[mode, prefix].filter(Boolean).join(" ") || "the request"}.`);
for (const [index, suite] of suites.entries()) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-test-suite-"));
  console.log(`[${index + 1}/${suites.length}] ${suite}`);
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
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
