import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { connectRuntimeHost } from "../src/runtime/host/connection.js";
import { runtimeHostLaunchPlan, runtimeHostPaths, waitForHostRegistration } from "../src/runtime/host/lifecycle.js";

// The small Electron probe cannot detect failures in the built Desktop entry and real Host assembly.
test("构建后的 Desktop 后台入口提供真实 Host socket，并在空闲后正常退出", {
  skip: process.platform !== "darwin", timeout: 30_000
}, async () => {
  await access("out/main/index.js");
  await promisify(execFile)(process.execPath, ["scripts/prepare-electron-background.mjs"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-built-host-"));
  const configDir = path.join(root, "config");
  const config = createFileConfigStore(root, { globalDir: configDir });
  await config.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    activity: { ...defaultConfig.activity, enabled: false }
  });
  const plan = runtimeHostLaunchPlan(root, { workspaceRoot: root, configDir,
    electronAppPath: process.cwd(), idleGraceMs: 1_000 }, {
    platform: "darwin", execPath: createRequire(import.meta.url)("electron") as string
  });
  plan.args.splice(1, 0, `--user-data-dir=${path.join(root, "electron-profile")}`);
  const child = spawn(plan.executable, plan.args, { env: plan.env, stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  try {
    const registration = await waitForHostRegistration(root, child);
    assert.equal(registration.pid, child.pid);
    client = await connectRuntimeHost(root, { configDir, clientId: "built-host-probe", surface: "desktop", keepAlive: true });
    assert.ok(client, "the built Host must accept the Desktop protocol");
    assert.equal(client.getSnapshot().state.kind, "idle");
    await client.close(); client = undefined;
    const result = await Promise.race([exited, new Promise<never>((_, reject) => {
      const deadline = setTimeout(() => reject(new Error("built Host did not retire")), 10_000);
      deadline.unref(); void exited.then(() => clearTimeout(deadline));
    })]);
    assert.deepEqual(result, [0, null]);
    await assert.rejects(access(runtimeHostPaths(root).registrationPath), { code: "ENOENT" });
  } finally {
    await client?.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
