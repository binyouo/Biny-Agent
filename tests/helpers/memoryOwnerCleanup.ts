import type { RmOptions } from "node:fs";
import { lstat, opendir, readdir, readFile, realpath, rm as remove } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeHostPaths, isProcessAlive } from "../../src/runtime/host/lifecycle.js";

const memoryOwnerPaths = (root: string) => runtimeHostPaths(path.join(root, ".memory-owner"), { platform: process.platform, temporaryDirectory: os.tmpdir(), agentRoot: root });

/** Detached owners belong to the test's temporary data root, not its session. */
interface OwnerScanCounts { matched: number; signalled: number; stopped: number; }
export async function stopTestMemoryOwners(root: string, counts?: OwnerScanCounts): Promise<void> {
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
    if (counts) counts.matched += 1;
    try { process.kill(record.pid!, "SIGTERM"); if (counts) counts.signalled += 1; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 12_000;
    while (isProcessAlive(record.pid!)) {
      if (Date.now() >= deadline) throw new Error(`Test memory owner ${record.pid} did not stop.`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (counts) counts.stopped += 1;
  }
}

export interface CapturedTestFailure { present: true; error: unknown; }
interface CleanupDiagnosticsOptions { diagnostic: true; primary?: CapturedTestFailure; }
interface DirectoryEntry { name: string; isSymbolicLink(): boolean; isDirectory(): boolean; }
interface DiagnosticIO {
  realpath(value: string): Promise<string>;
  lstat(value: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  opendir(value: string): Promise<{ read(): Promise<DirectoryEntry | null>; close(): Promise<void> }>;
  temporaryDirectory: string;
}

// Opt-in only for two synthetic CI roots. Never read file contents; skip observed links.
// This best-effort inventory is not an atomic no-follow sandbox against path swaps.
async function collectTestRootDiagnostics(root: string, counts: OwnerScanCounts, io: DiagnosticIO): Promise<unknown> {
  const unavailable = { available: false, reason: "unvalidated synthetic root", owners: counts };
  const rootInfo = await io.lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return unavailable;
  const canonical = await io.realpath(root);
  const temporary = await io.realpath(io.temporaryDirectory);
  if (path.dirname(canonical) !== temporary || !/^biny-(?:session-goal-lifecycle|emotion-session-test)-[A-Za-z0-9]+$/u.test(path.basename(canonical))) return unavailable;
  const entries: Array<{ name: string; kind: string }> = [];
  const queue = [{ directory: canonical, relative: "", depth: 0 }];
  let truncated = false;
  while (queue.length && entries.length < 32) {
    const current = queue.shift()!;
    const info = await io.lstat(current.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    const directory = await io.opendir(current.directory);
    try {
      while (entries.length < 32) {
        const entry = await directory.read();
        if (!entry) break;
        const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        // JSON escaping prevents control characters from becoming log directives.
        const display = relative.slice(0, 120);
        if (display !== relative) truncated = true;
        entries.push({ name: display, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (current.depth < 1) queue.push({ directory: path.join(current.directory, entry.name), relative, depth: current.depth + 1 });
          else truncated = true;
        }
      }
      if (entries.length === 32) truncated = true;
    } finally { await directory.close(); }
  }
  if (queue.length) truncated = true;
  return { available: true, entries, truncated, owners: counts };
}

async function runTestRootCleanup(cleanup: () => Promise<void>, diagnose: () => Promise<unknown>, primary?: CapturedTestFailure,
  report: (text: string) => void = text => console.error(text)): Promise<void> {
  try { await cleanup(); }
  catch (cleanupError) {
    try {
      const details = await diagnose();
      let serialized = JSON.stringify(details);
      if (Buffer.byteLength(serialized, "utf8") > 8_000) serialized = JSON.stringify({ available: false, truncated: true, reason: "diagnostic size limit" });
      report(`Test root cleanup diagnostic: ${serialized}`);
    } catch { /* Diagnostics must never replace the original failure. */ }
    if (primary?.present) throw new AggregateError([primary.error, cleanupError], "Test body and cleanup both failed.");
    throw cleanupError;
  }
}

export async function removeTestRoot(root: Parameters<typeof remove>[0], options?: RmOptions, diagnostics?: CleanupDiagnosticsOptions): Promise<void> {
  const counts: OwnerScanCounts = { matched: 0, signalled: 0, stopped: 0 };
  const cleanup = async (): Promise<void> => {
    if (options?.recursive && typeof root === "string") await stopTestMemoryOwners(root, diagnostics ? counts : undefined);
    await remove(root, options);
  };
  if (!diagnostics) return await cleanup();
  await runTestRootCleanup(cleanup, async () => typeof root === "string"
    ? await collectTestRootDiagnostics(root, counts, { realpath, lstat, opendir, temporaryDirectory: os.tmpdir() })
    : { available: false, reason: "non-string root" }, diagnostics.primary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stopTestMemoryOwners(process.argv[2]!);
}
