import assert from "node:assert/strict";
import path from "node:path";
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
  assert.equal(plan.executable, `${contents}/Frameworks/${executableName} Helper.app/Contents/MacOS/${executableName} Helper`,
    "macOS Host must launch through the background Helper bundle, not a foreground app hidden after startup");
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
}

console.log("runtime-host lifecycle tests passed");
