/** 文件审批与命令沙箱共用路径规则；无路径前缀的名称匹配任意层级，其他规则相对工作区解析。 */
import { realpathSync } from "node:fs";
import path from "node:path";

export function compileDeniedPaths(rules: readonly string[], workspaceRoot: string): { patterns: string[]; ancestors: string[] } {
  const ancestors = new Set<string>();
  const patterns = rules.flatMap((input) => {
    const rule = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!rule) throw new Error("Permission path rules must not be empty or a filesystem root.");
    if (!rule.includes("/") && rule !== "." && rule !== "..") {
      return [`(^|/)${escapeRegex(rule)}${rule === ".env" ? "([.][^/]*)?" : ""}(/|$)`];
    }
    const absolute = path.resolve(workspaceRoot, rule);
    return [...new Set([absolute, canonicalPath(absolute)])].map((entry) => {
      // 否则命令能先重命名父目录，再从新路径读取原先被禁止的内容。
      for (let parent = path.dirname(entry); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        ancestors.add(parent);
      }
      return `^${escapeRegex(entry.replaceAll("\\", "/"))}(/|$)`;
    });
  });
  return { patterns, ancestors: [...ancestors] };
}

export function matchingDeniedPath(target: string, rules: readonly string[], workspaceRoot: string, changingPath: boolean): string | undefined {
  const absolute = path.resolve(workspaceRoot, target);
  const candidates = [absolute, canonicalPath(absolute)].map((entry) => entry.replaceAll("\\", "/"));
  return rules.find((rule) => {
    const { patterns, ancestors } = compileDeniedPaths([rule], workspaceRoot);
    return patterns.some((pattern) => candidates.some((candidate) => new RegExp(pattern).test(candidate)))
      || changingPath && ancestors.some((ancestor) => candidates.includes(ancestor.replaceAll("\\", "/")));
  });
}

// 新建文件也需要解析已有父目录的符号链接，不能在 ENOENT 时把整个路径当作未解析路径。
function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(value);
    if (parent === value) return value;
    return path.join(canonicalPath(parent), path.basename(value));
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
