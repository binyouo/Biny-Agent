import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { restrictWindowsPathAccess } from "./windowsSecurity.js";

export function localIpcEndpoint(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return filePath;
  const identity = createHash("sha256").update(filePath).digest("hex");
  return `\\\\.\\pipe\\biny-${identity}`;
}

export async function removeLocalIpcEndpoint(endpoint: string): Promise<void> {
  if (endpoint.startsWith("\\\\.\\pipe\\")) return;
  await fs.unlink(endpoint).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function secureLocalIpcEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") await restrictWindowsPathAccess(endpoint, "pipe");
  else await fs.chmod(endpoint, 0o600);
}
