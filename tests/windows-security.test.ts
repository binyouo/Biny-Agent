import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";
import { restrictWindowsPathAccess } from "../src/utils/windowsSecurity.js";
import { registerDesktopRuntimeHost, runtimeHostLaunchPlan } from "../src/runtime/host/lifecycle.js";
import { localIpcEndpoint, secureLocalIpcEndpoint } from "../src/utils/localIpc.js";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

for (const fails of [false, true]) {
  test(`Windows private IPC ACL helper ${fails ? "refuses failures" : "uses an explicit system PowerShell and private path input"}`, async (context) => {
    const oldRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\Windows";
    const target = "\\\\.\\pipe\\biny-'quoted-$path";
    const helperError = new Error("synthetic ACL failure");
    const exec = context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
      assert.equal(args[0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.ok(!(args[1] as string[]).includes(target));
      const options = args[2] as { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv };
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout > 0 && options.timeout <= 60_000);
      assert.equal(options.env.BINY_IPC_PRIVATE_PATH, target);
      (args[3] as (error: Error | null) => void)(fails ? helperError : null);
      return new childProcess.ChildProcess();
    });
    syncBuiltinESMExports();
    try {
      if (fails) await assert.rejects(restrictWindowsPathAccess(target, "pipe"), (error: unknown) => error instanceof Error && /endpoint was refused/u.test(error.message) && error.cause === helperError);
      else await restrictWindowsPathAccess(target, "pipe");
    } finally {
      if (oldRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = oldRoot;
      exec.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("CLI cold launch reuses the registered Desktop installation for encrypted credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "biny-desktop-location-"));
  const executable = path.join(root, "Biny executable.exe");
  const appPath = path.join(root, "app.asar");
  try {
    await writeFile(executable, "synthetic executable");
    await writeFile(appPath, "synthetic application");
    await writeFile(path.join(root, "credentials.enc"), "synthetic cipher");
    await registerDesktopRuntimeHost({ executable, appPath, configDir: root });
    const launch = runtimeHostLaunchPlan(root, { workspaceRoot: root, configDir: root }, { platform: "win32", execPath: process.execPath });
    assert.equal(launch.executable, executable);
    assert.deepEqual(launch.args.slice(0, 2), [appPath, "--biny-runtime-host"]);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined);
    await rm(executable);
    assert.throws(() => runtimeHostLaunchPlan(root, { workspaceRoot: root, configDir: root }), /启动位置已失效/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native Windows directories, inherited files and named pipes only grant the current account and SYSTEM", { skip: process.platform !== "win32", timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "biny-native-acl-"));
  const endpoint = localIpcEndpoint(path.join(root, "private.sock"));
  const server = net.createServer((socket) => socket.destroy());
  const script = `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = (Get-Item -LiteralPath $env:BINY_TEST_ACL_PATH -Force).GetAccessControl()
    $accounts = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    @{ accounts = $accounts; sid = $sid; protected = $acl.AreAccessRulesProtected } | ConvertTo-Json -Compress
  `;
  const check = async (target: string, protectedAcl: boolean): Promise<void> => {
    const { stdout } = await promisify(childProcess.execFile)(path.win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, BINY_TEST_ACL_PATH: target }, windowsHide: true, timeout: 30_000
    });
    const result = JSON.parse(stdout) as { accounts: string[]; sid: string; protected: boolean };
    assert.deepEqual(result.accounts.sort(), [...new Set([result.sid, "S-1-5-18"])].sort());
    assert.equal(result.protected, protectedAcl);
  };
  try {
    await restrictWindowsPathAccess(root, "directory");
    await check(root, true);
    const file = path.join(root, "registration.json");
    await writeFile(file, "synthetic registration");
    await check(file, false);
    const lockRoot = path.join(root, "write-lock");
    await withLocalFileWriteLock(lockRoot, "state.lock", async () => {
      await check(lockRoot, true);
      await check(path.join(lockRoot, "state.lock.authority.sqlite"), true);
      await check(path.join(lockRoot, "state.lock"), false);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    await secureLocalIpcEndpoint(endpoint);
    await check(endpoint, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
