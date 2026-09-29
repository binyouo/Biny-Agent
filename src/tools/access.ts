/**
 * 工具资源访问声明模块。
 *
 * ToolScheduler 通过这些声明判断工具能否并发运行。读和搜索可以重叠，写入同一路径或其父子
 * 路径时会串行，未知副作用用 all() 保守处理。
 */
import path from "node:path";

export type ToolFileOperation = "read" | "write" | "readwrite" | "search";

export type ToolResourceAccess =
  | { kind: "all" }
  | { kind: "browser"; contextId: string }
  | { kind: "file"; operation: ToolFileOperation; path: string; recursive?: boolean };

export type ToolAccessList = readonly ToolResourceAccess[];

export const ToolAccesses = {
  none(): ToolAccessList {
    return [];
  },
  all(): ToolAccessList {
    return [{ kind: "all" }];
  },
  browser(contextId: string): ToolAccessList {
    if (!contextId.trim()) throw new Error("Browser context id must not be empty.");
    return [{ kind: "browser", contextId }];
  },
  readFile(filePath: string): ToolAccessList {
    return file("read", filePath);
  },
  readTree(filePath: string): ToolAccessList {
    return file("read", filePath, true);
  },
  writeFile(filePath: string): ToolAccessList {
    return file("write", filePath);
  },
  writeTree(filePath: string): ToolAccessList {
    return file("write", filePath, true);
  },
  readWriteFile(filePath: string): ToolAccessList {
    return file("readwrite", filePath);
  },
  readWriteTree(filePath: string): ToolAccessList {
    return file("readwrite", filePath, true);
  },
  searchTree(filePath: string): ToolAccessList {
    return file("search", filePath, true);
  },
  conflict(left: ToolAccessList, right: ToolAccessList): boolean {
    return left.some((leftAccess) => right.some((rightAccess) => conflicts(leftAccess, rightAccess)));
  }
};

function file(operation: ToolFileOperation, filePath: string, recursive = false): ToolAccessList {
  return [{ kind: "file", operation, path: normalizeAccessPath(filePath), recursive }];
}

function conflicts(left: ToolResourceAccess, right: ToolResourceAccess): boolean {
  if (left.kind === "all" || right.kind === "all") return true;
  if (left.kind === "browser" || right.kind === "browser") {
    return left.kind === "browser" && right.kind === "browser" && left.contextId === right.contextId;
  }
  if (!pathOverlaps(left, right)) return false;
  return isWriteOperation(left.operation) || isWriteOperation(right.operation);
}

function isWriteOperation(operation: ToolFileOperation): boolean {
  return operation === "write" || operation === "readwrite";
}

function pathOverlaps(left: Extract<ToolResourceAccess, { kind: "file" }>, right: Extract<ToolResourceAccess, { kind: "file" }>): boolean {
  if (left.path === right.path) return true;
  if (left.recursive && isWithin(left.path, right.path)) return true;
  if (right.recursive && isWithin(right.path, left.path)) return true;
  return false;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeAccessPath(value: string): string {
  return path.resolve(value);
}
