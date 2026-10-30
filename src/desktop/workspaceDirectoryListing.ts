import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { resolveWorkspaceDirectory } from "../workspace/resolvePath.js";
import type { DesktopWorkspaceDirectory, DesktopWorkspaceDirectoryEntry } from "./protocol.js";

const browserIgnore = ["node_modules", ".git"];

/** Keep tree addresses lexical; use canonical paths only for authorization and reads. */
export async function readDesktopWorkspaceDirectory(root: string, requestedPath: string): Promise<DesktopWorkspaceDirectory> {
  const directory = resolveWorkspaceDirectory(root, requestedPath, browserIgnore);
  // The resolver above already enforces the lexical project boundary, including absolute requests.
  const displayPath = path.relative(path.resolve(root), path.resolve(root, requestedPath)) || ".";
  const canonicalRoot = resolveWorkspaceDirectory(root, ".", browserIgnore);
  const ancestors = new Set<string>([canonicalRoot]);
  const ordinaryPath = directory === path.resolve(canonicalRoot, displayPath);
  let prefix = ".";
  for (const segment of displayPath.split(path.sep).filter(part => part && part !== ".")) {
    prefix = path.join(prefix, segment);
    // Ordinary paths need no repeated filesystem canonicalization of every prefix.
    // The full requested path was authorized above. Prefixes are identities for cycle
    // detection, not separate file requests (e.g. config.json/nested is allowed).
    const canonical = ordinaryPath ? path.resolve(canonicalRoot, prefix) : realpathSync.native(path.resolve(root, prefix));
    if (ancestors.has(canonical)) throw new Error("Directory contains a cyclic symbolic link.");
    ancestors.add(canonical);
  }
  const initial = await fs.lstat(directory);
  if (!initial.isDirectory()) throw new Error(`Path is not a directory: ${requestedPath}`);
  const children = await fs.readdir(directory, { withFileTypes: true });
  const entries: DesktopWorkspaceDirectoryEntry[] = [];
  for (const child of children) {
    const childPath = displayPath === "." ? child.name : path.join(displayPath, child.name);
    let kind: "directory" | "file" = child.isDirectory() ? "directory" : "file";
    if (child.isSymbolicLink()) {
      try {
        const target = resolveWorkspaceDirectory(root, childPath, browserIgnore);
        if (ancestors.has(target)) throw new Error("Cyclic directory link");
        const stat = await fs.lstat(target);
        // Do not adopt a target that became another link while classification awaited.
        if (resolveWorkspaceDirectory(root, childPath, browserIgnore) !== target) throw new Error("Changed directory link");
        if (stat.isDirectory()) kind = "directory";
      } catch { /* Preserve the old file row; opening still uses the original authorization. */ }
    }
    entries.push({ name: child.name, path: childPath.split(path.sep).join("/"), kind });
  }
  // Reject observed renames/rebindings rather than publishing a stale directory under a new alias.
  if (resolveWorkspaceDirectory(root, requestedPath, browserIgnore) !== directory) throw new Error("Directory changed while being read; refresh to retry.");
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.dev !== initial.dev || current.ino !== initial.ino
    || resolveWorkspaceDirectory(root, requestedPath, browserIgnore) !== directory) {
    throw new Error("Directory changed while being read; refresh to retry.");
  }
  entries.sort((left, right) => left.kind !== right.kind ? left.kind === "directory" ? -1 : 1 : left.name.localeCompare(right.name));
  return { path: displayPath.split(path.sep).join("/"), entries };
}

/** Call only after the requested path has passed workspace authorization. */
export function workspaceTreePath(root: string, requestedPath: string): string {
  return (path.relative(path.resolve(root), path.resolve(root, requestedPath)) || ".").split(path.sep).join("/");
}
