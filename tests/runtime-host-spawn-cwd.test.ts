import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { spawnRuntimeHostProcess } from "../src/runtime/host/lifecycle.js";

for (const packaged of [false, true]) {
  test(`Desktop Host 从真实项目目录启动子进程（${packaged ? "安装包" : "源码"}）`, { timeout: 20_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-cwd-")));
    let child: ChildProcess | undefined;
    try {
      const workspace = path.join(root, "项目 with spaces");
      await mkdir(workspace);
      const receipt = path.join(root, "started.json");
      const entry = path.join(root, "probe.cjs");
      // Node 代替 Electron 可执行文件；仍由生产启动函数创建真实子进程。
      await writeFile(entry, `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));`);
      let launch = spawnRuntimeHostProcess;
      if (packaged) {
        const archive = path.join(root, "app.asar");
        const module = path.join(archive, "out/main/chunks/lifecycle.mjs");
        await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        await build({ entryPoints: ["src/runtime/host/lifecycle.ts"], outfile: module,
          bundle: true, platform: "node", format: "esm", packages: "external" });
        launch = (await import(pathToFileURL(module).href) as typeof import("../src/runtime/host/lifecycle.js")).spawnRuntimeHostProcess;
        // 模块已加载后保留其 archive URL，但将 archive 变成文件，重现 OS 无法 chdir 的边界。
        await rename(archive, `${archive}.unpacked`);
        await writeFile(archive, "archive fixture");
      }
      child = launch(root, { workspaceRoot: workspace, configDir: root, electronAppPath: entry });
      child.ref();
      assert.deepEqual(await once(child, "exit", { signal: AbortSignal.timeout(5_000) }), [0, null]);
      const result = JSON.parse(await readFile(receipt, "utf8")) as { cwd: string; args: string[] };
      assert.equal(result.cwd, workspace);
      assert.equal(result.args[0], "--biny-runtime-host");
      assert.equal(result.args[result.args.indexOf("--workspace-root") + 1], workspace);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
