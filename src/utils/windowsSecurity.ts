import { execFile } from "node:child_process";
import path from "node:path";

/** Windows 没有 POSIX mode；本地控制端点和凭据目录必须用 DACL 限制到当前账号。 */
export async function restrictWindowsPathAccess(target: string, kind: "directory" | "file" | "pipe"): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Cannot locate Windows PowerShell to protect local IPC.");
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$security = if ($env:BINY_IPC_PATH_KIND -eq 'directory') {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$security.SetAccessRuleProtection($true, $false)
$inheritance = if ($env:BINY_IPC_PATH_KIND -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else { [System.Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in @($identity.User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow))
}
$item = Get-Item -LiteralPath $env:BINY_IPC_PRIVATE_PATH -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Local IPC path must not be a reparse point' }
$owner = $item.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if (@($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $owner) { throw 'Local IPC path has a different user owner' }
$item.SetAccessControl($security)
`;
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, BINY_IPC_PRIVATE_PATH: target, BINY_IPC_PATH_KIND: kind },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024
    }, (error) => {
      if (error) reject(new Error("Cannot restrict local IPC access to the current Windows user; endpoint was refused.", { cause: error }));
      else resolve();
    });
  });
}
