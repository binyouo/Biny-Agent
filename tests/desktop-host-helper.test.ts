import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import { runtimeHostLaunchPlan } from "../src/runtime/host/lifecycle.js";

test("macOS Host 保持存活并可使用 Electron 网络服务与凭据 API", {
  skip: process.platform !== "darwin", timeout: 20_000
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-helper-"));
  const server = createServer((_request, response) => response.end("host-ready"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const startup = path.join(root, "startup.cjs");
    await build({ entryPoints: ["src/desktop/electron/main/runtimeHostStartup.ts"], bundle: true, platform: "node", format: "cjs", outfile: startup });
    const entry = path.join(root, "host.cjs");
    await writeFile(entry, `
      const { app, BrowserWindow, safeStorage, net } = require("electron");
      app.setName("Biny");
      let dockAtReady;
      app.once("ready", () => { dockAtReady = app.dock.isVisible(); });
      require(${JSON.stringify(startup)}).startRuntimeHostApp(app, async () => {
        const response = await net.fetch("http://127.0.0.1:${address.port}");
        const body = await response.text();
        // 旧入口在 ready 之后因 Chromium 子进程连续退出而崩溃，必须跨过该初始化窗口。
        await new Promise(resolve => setTimeout(resolve, 1200));
        process.stdout.write(JSON.stringify({
          execPath: process.execPath,
          body,
          windowCount: BrowserWindow.getAllWindows().length,
          cipher: typeof safeStorage.encryptString,
          decipher: typeof safeStorage.decryptString,
          dockAtReady,
          dockVisible: app.dock.isVisible()
        }));
        app.exit(0);
      }).catch(() => app.exit(1));
    `);
    const executable = createRequire(import.meta.url)("electron") as string;
    const plan = runtimeHostLaunchPlan(root, { workspaceRoot: root, electronAppPath: entry }, {
      platform: "darwin", execPath: executable
    });
    const { stdout } = await promisify(execFile)(plan.executable, plan.args, { env: plan.env, timeout: 15_000 });
    assert.deepEqual(JSON.parse(stdout), { execPath: plan.executable, body: "host-ready", windowCount: 0, cipher: "function", decipher: "function", dockAtReady: false, dockVisible: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
