/**
 * SkillHub 与 Agent runtime 共用的 Skill 根目录约定。
 *
 * `engines` 只描述目录归属；真正的文件安全校验仍由各自的读取模块负责。
 */
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";

export type SkillRootEngine = "biny" | "codex" | "claude" | "pi";
export type SkillRootSource = "biny" | "agents" | "builtin";
export type SkillRootScope = "builtin" | "global" | "project";

export interface SkillRootConvention {
  relativePath: string;
  engines: readonly SkillRootEngine[];
  source: SkillRootSource;
  /** 全局 `.agents/skills` 是用户显式管理的入口，可保留指向其他 Skill 根的软链。 */
  allowExternalSymlinks?: boolean;
}

export const PROJECT_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  { relativePath: ".biny/skills", engines: ["biny"], source: "biny" },
  { relativePath: ".agents/skills", engines: ["codex", "pi"], source: "agents", allowExternalSymlinks: true }
];

export const GLOBAL_SKILL_ROOT_CONVENTIONS: readonly SkillRootConvention[] = [
  ...PROJECT_SKILL_ROOT_CONVENTIONS,
  { relativePath: ".claude/skills", engines: ["claude"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".codex/skills", engines: ["codex"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".pi/agent/skills", engines: ["pi"], source: "agents", allowExternalSymlinks: true },
  { relativePath: ".cc-switch/skills", engines: ["claude", "codex", "pi"], source: "agents", allowExternalSymlinks: true }
];

export const DEFAULT_PROJECT_SKILL_PATHS = PROJECT_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => relativePath);

/**
 * 返回 Skill 根的跨 scope 优先级；数值越小越优先。
 *
 * 项目 Skill 必须覆盖全局 Skill。全局配置目录不是 home 下的
 * `.biny/skills`，因此需要先按实际解析后的路径识别它。
 * 省略 homeDir 时尊重环境配置；显式传入时与 defaultGlobalSkillRoots 一样保持隔离。
 */
export function skillRootPrecedence(scope: SkillRootScope, configuredPath: string, homeDir?: string): number {
  if (scope === "builtin") return 300;
  const conventions = scope === "project" ? PROJECT_SKILL_ROOT_CONVENTIONS : GLOBAL_SKILL_ROOT_CONVENTIONS;
  let relativePath = path.normalize(configuredPath).split(path.sep).join("/");
  if (scope === "global") {
    const configRoot = homeDir === undefined
      ? globalConfigDir()
      : globalConfigDir({ env: {}, homeDir });
    if (path.resolve(configuredPath) === path.resolve(configRoot, "skills")) {
      relativePath = ".biny/skills";
    } else if (path.isAbsolute(configuredPath)) {
      relativePath = path.relative(homeDir ?? os.homedir(), path.resolve(configuredPath)).split(path.sep).join("/");
    }
  }
  const index = conventions.findIndex((convention) => convention.relativePath === relativePath);
  const fallback = conventions.length + 1;
  return (scope === "project" ? 0 : 100) + (index === -1 ? fallback : index);
}

export function defaultGlobalSkillRoots(homeDir?: string): string[] {
  const resolvedHome = homeDir ?? os.homedir();
  const configRoot = homeDir === undefined
    ? globalConfigDir()
    : globalConfigDir({ env: {}, homeDir });
  return GLOBAL_SKILL_ROOT_CONVENTIONS.map(({ relativePath }) => {
    if (relativePath === ".biny/skills") return path.join(configRoot, "skills");
    return path.isAbsolute(relativePath) ? relativePath : path.join(resolvedHome, relativePath);
  });
}
