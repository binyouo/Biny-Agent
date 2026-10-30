/**
 * 工作区路径解析模块。
 *
 * 文件工具统一通过这里把用户传入路径转换成工作区内绝对路径。`../`、绝对路径逃逸以及命中
 * ignore 规则的路径都会被拒绝，避免工具访问项目边界之外的内容。
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "./ignore.js";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string, ignore: string[]): string {
  return resolveWorkspaceLocation(workspaceRoot, requestedPath, ignore, false);
}

/** Delete/move operate on a named file entry, never on a final symbolic link's referent. */
export function resolveWorkspaceFileEntry(workspaceRoot: string, requestedPath: string, ignore: string[]): string {
  // Retain both lexical and canonical workspace/ignore checks, including directory aliases.
  const canonicalPath = resolveWorkspacePath(workspaceRoot, requestedPath, ignore);
  if (lstatSync(path.resolve(workspaceRoot, requestedPath)).isSymbolicLink()) {
    throw new Error("Delete and move do not accept symbolic-link files. Specify the intended regular file explicitly.");
  }
  return canonicalPath;
}

/** Directory browsers may address the workspace root itself while retaining all other path protections. */
export function resolveWorkspaceDirectory(workspaceRoot: string, requestedPath: string, ignore: string[]): string {
  return resolveWorkspaceLocation(workspaceRoot, requestedPath, ignore, true);
}

function resolveWorkspaceLocation(workspaceRoot: string, requestedPath: string, ignore: string[], allowRoot: boolean): string {
  const absoluteRoot = path.resolve(workspaceRoot);
  const absolute = path.resolve(absoluteRoot, requestedPath);
  const relative = path.relative(absoluteRoot, absolute);

  // 所有文件工具都必须先过这个检查，防止通过 ../ 或绝对路径逃出工作区。
  if ((!allowRoot && relative === "") || escapesRoot(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  // ignore 既保护 node_modules/.git 这类大目录，也避免本地私有说明文件进入工具结果。
  if (relative !== "" && isIgnoredPath(relative, ignore)) {
    throw new Error(`Path is ignored by workspace policy: ${requestedPath}`);
  }

  const canonicalRoot = realpathSync.native(absoluteRoot);
  const canonicalPath = canonicalizePath(absolute);
  const canonicalRelative = path.relative(canonicalRoot, canonicalPath);
  if ((!allowRoot && canonicalRelative === "") || escapesRoot(canonicalRelative)) {
    throw new Error(`Path escapes workspace through a symbolic link: ${requestedPath}`);
  }
  if (canonicalRelative !== "" && isIgnoredPath(canonicalRelative, ignore)) {
    throw new Error(`Path resolves to a location ignored by workspace policy: ${requestedPath}`);
  }

  return canonicalPath;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const canonicalRoot = realpathSync.native(path.resolve(workspaceRoot));
  return path.relative(canonicalRoot, canonicalizePath(path.resolve(absolutePath))) || ".";
}

function canonicalizePath(value: string): string {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const candidate = path.join(current, segment);
    try {
      lstatSync(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      return path.join(current, ...segments.slice(index));
    }
    try {
      current = realpathSync.native(candidate);
    } catch (error) {
      if (isMissingPathError(error)) throw new Error(`Path contains a dangling symbolic link: ${candidate}`);
      throw error;
    }
  }
  return current;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

