import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeHostLaunchPlan } from "../src/runtime/host/lifecycle.js";

test("macOS Host 使用自带后台 Helper，真实子进程可访问 Electron 主进程 API", {
  skip: process.platform !== "darwin", timeout: 20_000
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-helper-"));
  try {
    const entry = path.join(root, "host.cjs");
    await writeFile(entry, `
      const { app, BrowserWindow, safeStorage } = require("electron");
      app.setName("Biny");
      app.whenReady().then(() => {
        process.stdout.write(JSON.stringify({
          execPath: process.execPath,
          windowCount: BrowserWindow.getAllWindows().length,
          cipher: typeof safeStorage.encryptString,
          decipher: typeof safeStorage.decryptString
        }));
        app.exit(0);
      }).catch(() => app.exit(1));
    `);
    const executable = createRequire(import.meta.url)("electron") as string;
    const plan = runtimeHostLaunchPlan(root, { workspaceRoot: root, electronAppPath: entry }, {
      platform: "darwin", execPath: executable
    });
    const infoPath = path.resolve(path.dirname(plan.executable), "../Info.plist");
    assert.match(await readFile(infoPath, "utf8"), /<key>LSUIElement<\/key>\s*<true\s*\/>/u);
    const { stdout } = await promisify(execFile)(plan.executable, plan.args, { env: plan.env, timeout: 15_000 });
    assert.deepEqual(JSON.parse(stdout), { execPath: plan.executable, windowCount: 0, cipher: "function", decipher: "function" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
