import type { RmOptions } from "node:fs";
import { lstat, readdir, readFile, realpath, rm as remove } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeHostPaths, isProcessAlive } from "../../src/runtime/host/lifecycle.js";

const memoryOwnerPaths = (root: string) => runtimeHostPaths(path.join(root, ".memory-owner"), { platform: process.platform, temporaryDirectory: os.tmpdir(), agentRoot: root });

/** Detached owners belong to the test's temporary data root, not its session. */
export async function stopTestMemoryOwners(root: string): Promise<void> {
  const canonical = await realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return path.resolve(root);
    throw error;
  });
  const temporary = await realpath(os.tmpdir());
  if (canonical === temporary || !canonical.startsWith(`${temporary}${path.sep}`)) return;
  const directory = path.dirname(memoryOwnerPaths(canonical).registrationPath);
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files.filter(file => /^biny-[a-f0-9]{24}(?:\.sock)?\.json$/u.test(file))) {
    let record: { agentRoot?: string; persistenceRoot?: string; pid?: number };
    try {
      const filePath = path.join(directory, file);
      if (!(await lstat(filePath)).isFile()) continue;
      record = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!record || typeof record !== "object") continue;
    const agentRoot = record.agentRoot;
    if (typeof agentRoot !== "string" || (agentRoot !== canonical && !agentRoot.startsWith(`${canonical}${path.sep}`))
      || path.join(directory, file) !== memoryOwnerPaths(agentRoot).registrationPath
      || record.persistenceRoot !== path.join(agentRoot, ".memory-owner")
      || !Number.isSafeInteger(record.pid) || record.pid! <= 1 || record.pid === process.pid || !isProcessAlive(record.pid!)) continue;
    try { process.kill(record.pid!, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 12_000;
    while (isProcessAlive(record.pid!)) {
      if (Date.now() >= deadline) throw new Error(`Test memory owner ${record.pid} did not stop.`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

export async function removeTestRoot(root: Parameters<typeof remove>[0], options?: RmOptions): Promise<void> {
  if (options?.recursive && typeof root === "string") await stopTestMemoryOwners(root);
  await remove(root, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stopTestMemoryOwners(process.argv[2]!);
}
