import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { restrictWindowsPathAccess } from "../src/utils/windowsSecurity.js";
import { registerDesktopRuntimeHost, runtimeHostLaunchPlan } from "../src/runtime/host/lifecycle.js";
import { localIpcEndpoint, secureLocalIpcEndpoint } from "../src/utils/localIpc.js";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

function aclCommandFailure(kind: unknown, error: { code?: unknown }, stderr: string) {
  const rawCode = error.code;
  const code = (typeof rawCode === "number" && Number.isInteger(rawCode) && rawCode >= -2_147_483_648 && rawCode <= 2_147_483_647)
    || (typeof rawCode === "string" && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(rawCode)) ? rawCode : null;
  const diagnostic = stderr.slice(0, 16 * 1024);
  return {
    kind: kind === "directory" || kind === "file" || kind === "pipe" ? kind : "inspection",
    code,
    categories: ["ObjectNotFound", "PermissionDenied", "InvalidOperation", "InvalidArgument", "NotImplemented", "SecurityError", "ReadError", "WriteError", "OpenError", "NotSpecified"].filter((value) => new RegExp(`CategoryInfo\\s*:\\s*${value}\\s*:`).test(diagnostic)),
    exceptions: ["ItemNotFoundException", "UnauthorizedAccessException", "IOException", "NotSupportedException", "MethodInvocationException", "RuntimeException", "ArgumentException", "Win32Exception"].filter((value) => diagnostic.includes(value)),
    operations: ["Get-Item", "GetAccessControl", "GetOwner", "SetAccessControl", "AddAccessRule", "SetAccessRuleProtection", "GetFileSecurityW", "SetFileSecurityW"].filter((value) => diagnostic.includes(value))
  };
}

test("native ACL failure diagnostics report bounded facts without command, path or credential text", () => {
  const failure = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand private-command"), { code: 1 });
  const stderr = "Get-Item : Cannot find path C:\\private-account\\secret-token\n    + CategoryInfo : ObjectNotFound: (private-path:String) [Get-Item], ItemNotFoundException\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand";
  assert.deepEqual(aclCommandFailure("pipe", failure, stderr), {
    kind: "pipe", code: 1, categories: ["ObjectNotFound"], exceptions: ["ItemNotFoundException"], operations: ["Get-Item"]
  });
  assert.deepEqual(aclCommandFailure("private-kind", Object.assign(new Error("private-message"), { code: "private-code" }), `${"x".repeat(16 * 1024)}GetAccessControl`), {
    kind: "inspection", code: null, categories: [], exceptions: [], operations: []
  });
  for (const code of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648]) {
    assert.equal(aclCommandFailure("file", { code }, "").code, null);
  }
});

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

test("Windows pipe ACL hardening rejects filesystem paths and remote or nested pipe names before invoking PowerShell", async (context) => {
  const oldRoot = process.env.SystemRoot;
  process.env.SystemRoot = "C:\\Windows";
  const exec = context.mock.method(childProcess, "execFile", () => {
    throw new Error("Invalid pipe targets must not reach PowerShell");
  });
  syncBuiltinESMExports();
  try {
    for (const target of ["C:\\private\\file", "\\\\remote\\pipe\\biny-test", "\\\\?\\pipe\\biny-test", "\\\\.\\pipe\\", "\\\\.\\pipe\\nested\\biny-test", "\\\\.\\pipe\\biny-\0test"]) {
      await assert.rejects(restrictWindowsPathAccess(target, "pipe"), /local named pipe/u);
    }
    assert.equal(exec.mock.callCount(), 0);
  } finally {
    if (oldRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = oldRoot;
    exec.mock.restore();
    syncBuiltinESMExports();
  }
});

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

test("native Windows directories, inherited files and named pipes only grant the current account and SYSTEM", { skip: process.platform !== "win32", timeout: 150_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "biny-native-acl-"));
  const endpoint = localIpcEndpoint(path.join(root, "private.sock"));
  let acceptedConnections = 0;
  const server = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.end("native-acl-ready");
  });
  let phase: "root-directory-hardening" | "root-directory-inspection" | "inherited-file-inspection" | "lock-acquisition" | "lock-directory-inspection" | "lock-authority-inspection" | "lock-marker-inspection" | "pipe-listen" | "pipe-hardening" | "pipe-inspection" | "pipe-connect" = "root-directory-hardening";
  let commandFailure: ReturnType<typeof aclCommandFailure> | undefined;
  const nativeExecFile = childProcess.execFile;
  const exec = context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv };
    const callback = args[3] as (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
    return Reflect.apply(nativeExecFile, childProcess, [...args.slice(0, 3), (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => {
      if (error) commandFailure = aclCommandFailure(options.env?.BINY_IPC_PATH_KIND, error, stderr);
      callback(error, stdout, stderr);
    }]);
  });
  syncBuiltinESMExports();
  const script = `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($env:BINY_TEST_ACL_KIND -eq 'pipe') {
      Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NativePipeAclInspection {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetFileSecurityW(string name, uint information, [Out] byte[] descriptor, uint length, out uint needed);
}
'@
      $buffer = [byte[]]::new(1048576)
      $needed = [uint32]0
      if (-not [NativePipeAclInspection]::GetFileSecurityW($env:BINY_TEST_ACL_PATH, 5, $buffer, $buffer.Length, [ref]$needed)) {
        throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
      }
      $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($buffer, 0)
      $accounts = @($descriptor.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value } | Sort-Object -Unique)
      $protected = ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
      $owner = $descriptor.Owner.Value
    } else {
      $acl = (Get-Item -LiteralPath $env:BINY_TEST_ACL_PATH -Force).GetAccessControl()
      $accounts = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
      $protected = $acl.AreAccessRulesProtected
      $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    }
    @{ accounts = $accounts; sid = $sid; protected = $protected; owner = $owner } | ConvertTo-Json -Compress
  `;
  const check = async (target: string, protectedAcl: boolean, kind: "file" | "pipe" = "file"): Promise<void> => {
    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile(path.win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, BINY_TEST_ACL_PATH: target, BINY_TEST_ACL_KIND: kind }, windowsHide: true, timeout: 30_000
      }, (error, output) => { if (error) reject(error); else resolve(output); });
    });
    const result = JSON.parse(stdout) as { accounts: string[]; sid: string; protected: boolean; owner: string };
    assert.deepEqual(result.accounts.sort(), [...new Set([result.sid, "S-1-5-18"])].sort());
    assert.equal(result.protected, protectedAcl);
    assert.ok([result.sid, "S-1-5-18", "S-1-5-32-544"].includes(result.owner));
  };
  try {
    await restrictWindowsPathAccess(root, "directory");
    phase = "root-directory-inspection";
    await check(root, true);
    const file = path.join(root, "registration.json");
    await writeFile(file, "synthetic registration");
    phase = "inherited-file-inspection";
    await check(file, false);
    const lockRoot = path.join(root, "write-lock");
    phase = "lock-acquisition";
    await withLocalFileWriteLock(lockRoot, "state.lock", async () => {
      phase = "lock-directory-inspection";
      await check(lockRoot, true);
      phase = "lock-authority-inspection";
      await check(path.join(lockRoot, "state.lock.authority.sqlite"), true);
      phase = "lock-marker-inspection";
      await check(path.join(lockRoot, "state.lock"), false);
    });
    phase = "pipe-listen";
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    phase = "pipe-hardening";
    await secureLocalIpcEndpoint(endpoint);
    phase = "pipe-inspection";
    await check(endpoint, true, "pipe");
    assert.equal(acceptedConnections, 0, "ACL access must not consume a client connection");
    phase = "pipe-connect";
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(endpoint);
      let output = "";
      client.setEncoding("utf8");
      client.setTimeout(5_000, () => client.destroy(new Error("Hardened pipe connection timed out")));
      client.on("data", (data: string) => { output += data; });
      client.once("error", reject);
      client.once("end", () => { client.destroy(); resolve(output); });
    });
    assert.equal(response, "native-acl-ready");
    assert.equal(acceptedConnections, 1);
  } catch (error) {
    context.diagnostic(JSON.stringify({ nativeAclFailure: { phase, commandFailure } }));
    throw error;
  } finally {
    exec.mock.restore();
    syncBuiltinESMExports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
