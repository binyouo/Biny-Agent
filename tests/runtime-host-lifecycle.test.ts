import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeHostLaunchPlan,
  runtimeHostEntryPath,
  runtimeHostPaths
} from "../src/runtime/host/lifecycle.js";

const first = runtimeHostPaths("/workspace/one");
const equivalent = runtimeHostPaths(path.join("/workspace", "one"));
const second = runtimeHostPaths("/workspace/two");

assert.deepEqual(first, equivalent);
assert.notEqual(first.rootHash, second.rootHash);
assert.match(first.endpoint, /\.sock$/u);
assert.equal(first.registrationPath, `${first.endpoint}.json`);
assert.equal(first.lockPath, `${first.endpoint}.lock`);
assert.match(path.basename(runtimeHostEntryPath()), /^hostProcess\.(ts|js)$/u);

const detachedDesktopPlan = runtimeHostLaunchPlan("/workspace/data", {
  workspaceRoot: "/workspace/project",
  configDir: "/user/config",
  electronAppPath: "/Applications/Biny.app",
  lifecycleMode: "ephemeral",
  browserAutomation: { endpoint: "/tmp/browser.sock", token: "private-browser-token", projectId: "project-1" }
}, { platform: "linux", execPath: process.execPath });
assert.equal(detachedDesktopPlan.executable, process.execPath);
assert.deepEqual(detachedDesktopPlan.args.slice(0, 2), ["/Applications/Biny.app", "--biny-runtime-host"]);
assert.ok(detachedDesktopPlan.args.includes("ephemeral"), "Desktop Host must allow idle retirement");
assert.ok(detachedDesktopPlan.args.includes("--browser-automation-bootstrap"));
assert.ok(!detachedDesktopPlan.args.includes("private-browser-token"), "capability tokens must not appear in process arguments");
assert.ok(!Object.values(detachedDesktopPlan.env).includes("private-browser-token"), "capability tokens must not appear in process environment");
assert.equal(detachedDesktopPlan.env.ELECTRON_RUN_AS_NODE, undefined, "the detached Host must expose Electron safeStorage APIs");

for (const executableName of ["Biny", "Electron", "Biny Desktop"]) {
  const contents = `/Applications/${executableName}.app/Contents`;
  const plan = runtimeHostLaunchPlan("/workspace/data", {
    workspaceRoot: "/workspace/project",
    electronAppPath: `${contents}/Resources/app.asar`
  }, { platform: "darwin", execPath: `${contents}/MacOS/${executableName}` });
  assert.equal(plan.executable, `${contents}/MacOS/${executableName}`,
    "Host requires the Electron main executable so Chromium services can start");
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
}

// Given Desktop encrypted credentials and a Node caller, When electing a cold
// owner, Then launch the existing headless Electron entry to read those credentials.
const configRoot = await mkdtemp(path.join(os.tmpdir(), "biny-host-cipher-launch-"));
try {
  const nodePlan = runtimeHostLaunchPlan("/workspace/data", { workspaceRoot: "/workspace/project", configDir: configRoot });
  assert.equal(nodePlan.executable, process.execPath);
  await writeFile(path.join(configRoot, "credentials.enc"), "encrypted-fixture", { mode: 0o600 });
  const moduleRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  try {
    const cipherPlan = runtimeHostLaunchPlan("/workspace/data", {
      workspaceRoot: "/workspace/project", configDir: configRoot
    }, { platform: "darwin", execPath: process.execPath });
    assert.notEqual(cipherPlan.executable, process.execPath);
    assert.equal(cipherPlan.args[1], "--biny-runtime-host");
    if (existsSync(path.join(moduleRoot, "out/main/index.js"))) {
      assert.equal(cipherPlan.executable, createRequire(import.meta.url)("electron"));
      assert.equal(cipherPlan.args[0], moduleRoot);
    }
    assert.equal(cipherPlan.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.ok(!cipherPlan.args.includes("encrypted-fixture"));
  } catch (error) {
    if (existsSync(path.join(moduleRoot, "out/main/index.js"))) throw error;
    assert.match(String(error), /需要可启动的 Biny Desktop/u, "unbuilt installations must give an actionable startup error");
  }
} finally {
  await rm(configRoot, { recursive: true, force: true });
}

console.log("runtime-host lifecycle tests passed");
