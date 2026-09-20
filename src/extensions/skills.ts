/**
 * Agent Skills 扩展模块（渐进式披露，对齐 Agent Skills 范式）。
 *
 * 启动时只读取 YAML frontmatter；根回合能力分析完成后，选中 Skill 的正文和声明
 * 才进入首轮 system prompt。未选中的 Skill 仍可由 Skill/skill_lookup 动态发现，
 * references/scripts/assets 继续由 read_skill_resource 按需读取。
 * 默认发现 Biny 受管目录和各 Agent 的标准全局 Skill 根；全局入口中的已有软链会被保留，
 * 项目 Skill 根仍禁止越界软链，避免工作区配置意外扩大运行时读取范围。
 */
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillDocument, readSkillMetadataFields, type SkillMetadata } from "./skillDocument.js";
import { z } from "zod";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";
import { globalConfigDir } from "../config/paths.js";
import { DEFAULT_PROJECT_SKILL_PATHS, defaultGlobalSkillRoots, GLOBAL_SKILL_ROOT_CONVENTIONS, skillRootPrecedence, type SkillRootSource } from "./skillRoots.js";
import { resolveSkillActivation } from "./skillActivation.js";
import { createSkillId, createSkillRef } from "./skillRef.js";
import type { SkillRef } from "./skillTypes.js";
import type { CapabilitySelectionValue } from "../agent/capabilitySelection.js";
import { builtinSkillRoot } from "./builtinSkills.js";

const maxDiscoveredSkillCount = 256;
const maxSkillMetadataBytes = 64 * 1024;
const maxSkillInstructionBytes = 512 * 1024;
const maxSkillResourceBytes = 512 * 1024;
const maxSkillDescriptionChars = 1024;
const maxInitialSkillPromptChars = 8_000;
const maxListedSkillResources = 100;

export type SkillScope = "builtin" | "project" | "global";

export interface SkillDefinition extends SkillMetadata {
  ref: SkillRef;
  id: string;
  name: string;
  description: string;
  /** Display path: project skills are workspace-relative, global skills use "~/". */
  path: string;
  /** Canonical absolute path of the skill markdown file. */
  filePath: string;
  /** Root the file must stay inside when it is re-read at invoke time. */
  rootPath: string;
  scope: SkillScope;
  source: SkillRootSource;
}

export interface SkillBundle {
  skills: SkillDefinition[];
  paths: string[];
  prompt: string;
  warnings: string[];
  conflicts: SkillConflict[];
  /** 阻止部分 Skill 能力可用的加载问题；重复项等诊断不应放入这里。 */
  errors: string[];
}

export interface SkillConflict {
  name: string;
  winner: SkillDefinition;
  shadowed: SkillDefinition[];
}

export interface LoadSkillsOptions {
  workspaceRoot: string;
  /** Workspace-relative paths from extensions.skills. */
  projectPaths: string[];
  /** Isolated global skill directory; omitted means official, legacy, and admin roots. */
  globalRoot?: string;
  globalDefaults?: Readonly<Record<string, boolean>>;
  projectOverrides?: Readonly<Record<string, boolean>>;
}

interface SkillFileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface SkillFileCandidate {
  path: string;
  /** 收集该候选时所属的根；全局根的第一层跨根软链会以软链目标为新根，与扫描根不同。 */
  rootPath: string;
  snapshot: SkillFileSnapshot;
}

interface SkillCandidate {
  skill: SkillDefinition;
  precedence: number;
}

export async function loadSkills(options: LoadSkillsOptions): Promise<SkillBundle> {
  const canonicalWorkspace = await fs.realpath(path.resolve(options.workspaceRoot));
  const candidates: SkillCandidate[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  // 先收集所有合法候选，再按跨 scope 的统一优先级选胜者。
  for (const configuredPath of [...new Set([...DEFAULT_PROJECT_SKILL_PATHS, ...options.projectPaths])]) {
    if (candidates.length >= maxDiscoveredSkillCount) break;
    if (isOfficialProjectSkillPath(configuredPath)) {
      const repositoryRoot = await findRepositoryRoot(canonicalWorkspace);
      for (const target of officialProjectSkillTargets(canonicalWorkspace, repositoryRoot)) {
        const relative = path.relative(repositoryRoot, target);
        const absolutePath = await resolveRootedSkillPath(repositoryRoot, relative);
        if (!absolutePath) continue;
        const files: SkillFileCandidate[] = [];
        await collectSkillFiles(repositoryRoot, absolutePath, files, seen);
        // 目标目录按构造就是各级 .agents/skills，source 固定为 agents；当候选落在
        // canonicalWorkspace 之外（工作区是仓库子目录）时不能靠相对路径推断。
        await appendSkillDefinitions(candidates, warnings, errors, canonicalWorkspace, files, "project", skillRootPrecedence("project", ".agents/skills"), "agents");
      }
      continue;
    }
    const absolutePath = await resolveRootedSkillPath(canonicalWorkspace, configuredPath);
    if (!absolutePath) continue;
    const files: SkillFileCandidate[] = [];
    await collectSkillFiles(canonicalWorkspace, absolutePath, files, seen);
    await appendSkillDefinitions(candidates, warnings, errors, canonicalWorkspace, files, "project", skillRootPrecedence("project", configuredPath), sourceForProjectSkill(files[0]?.path, canonicalWorkspace));
  }

  // 显式传 globalRoot 时只扫描该目录（测试和嵌入方可隔离）；默认与 SkillHub 使用相同根目录。
  const globalRoots = options.globalRoot
    ? [options.globalRoot]
    : defaultGlobalSkillRoots();
  const resolvedGlobalRoots: Array<{ configuredPath: string; canonicalPath: string }> = [];
  for (const configuredPath of globalRoots) {
    try {
      const canonicalPath = await resolveGlobalSkillRoot(configuredPath);
      if (canonicalPath) resolvedGlobalRoots.push({ configuredPath, canonicalPath });
    } catch (error) {
      const message = `Skipped skill root ${configuredPath}: ${errorMessage(error)}`;
      warnings.push(message);
      errors.push(message);
    }
  }
  const allowedGlobalDirectories = [...new Set(resolvedGlobalRoots.map(({ canonicalPath }) => canonicalPath))];
  const globalSeen = new Set<string>();
  for (const { configuredPath, canonicalPath } of resolvedGlobalRoots) {
    if (candidates.length >= maxDiscoveredSkillCount) break;
    try {
      const globalFiles: SkillFileCandidate[] = [];
      await collectSkillFiles(canonicalPath, canonicalPath, globalFiles, globalSeen, true, allowedGlobalDirectories);
      await appendSkillDefinitions(candidates, warnings, errors, canonicalWorkspace, globalFiles, "global", skillRootPrecedence("global", configuredPath), sourceForGlobalRoot(configuredPath));
    } catch (error) {
      const message = `Skipped skill root ${canonicalPath}: ${errorMessage(error)}`;
      warnings.push(message);
      errors.push(message);
    }
  }

  const bundledRoot = builtinSkillRoot();
  const bundledFiles: SkillFileCandidate[] = [];
  await collectSkillFiles(bundledRoot, bundledRoot, bundledFiles, new Set<string>());
  await appendSkillDefinitions(candidates, warnings, errors, canonicalWorkspace, bundledFiles, "builtin", skillRootPrecedence("builtin", bundledRoot), "builtin");

  if (candidates.length >= maxDiscoveredSkillCount) {
    const message = `Only the first ${String(maxDiscoveredSkillCount)} skills were discovered.`;
    warnings.push(message);
    errors.push(message);
  }
  const { skills, conflicts } = selectSkillCandidates(candidates, options, warnings);
  return {
    skills,
    paths: skills.map((skill) => skill.path),
    prompt: buildSkillPrompt(skills),
    warnings,
    conflicts,
    errors
  };
}

function isOfficialProjectSkillPath(configuredPath: string): boolean {
  return path.normalize(configuredPath) === path.join(".agents", "skills");
}

/** 从 CWD 逐层扫描到当前仓库根目录；非 Git 目录只扫描当前目录。 */
async function findRepositoryRoot(workspaceRoot: string): Promise<string> {
  let current = workspaceRoot;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return workspaceRoot;
    current = parent;
  }
}

function officialProjectSkillTargets(workspaceRoot: string, repositoryRoot: string): string[] {
  const targets: string[] = [];
  let current = workspaceRoot;
  while (true) {
    targets.push(path.join(current, ".agents", "skills"));
    if (current === repositoryRoot) return targets;
    const parent = path.dirname(current);
    if (parent === current) return targets;
    current = parent;
  }
}

async function appendSkillDefinitions(
  candidates: SkillCandidate[],
  warnings: string[],
  errors: string[],
  projectRoot: string,
  files: SkillFileCandidate[],
  scope: SkillScope,
  precedence: number,
  source: SkillRootSource
): Promise<void> {
  const sorted = files.sort((left, right) => left.path.localeCompare(right.path));
  // 独立文件的绑定校验与元数据读取可以并行；有界批次保留确定顺序和发现上限。
  for (let offset = 0; offset < sorted.length && candidates.length < maxDiscoveredSkillCount;) {
    const batch = sorted.slice(offset, offset + Math.min(16, maxDiscoveredSkillCount - candidates.length));
    offset += batch.length;
    const results = await Promise.allSettled(batch.map((candidate) => readSkillMetadata(projectRoot, candidate, scope, source)));
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") candidates.push({ skill: result.value, precedence });
      else {
        const message = `Skipped ${batch[index]!.path}: ${errorMessage(result.reason)}`;
        warnings.push(message);
        errors.push(message);
      }
    }
  }
}

function selectSkillCandidates(
  candidates: SkillCandidate[],
  options: LoadSkillsOptions,
  warnings: string[]
): { skills: SkillDefinition[]; conflicts: SkillConflict[] } {
  const grouped = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.skill.name.toLocaleLowerCase();
    const group = grouped.get(key);
    if (group) group.push(candidate);
    else grouped.set(key, [candidate]);
  }

  const winners: SkillCandidate[] = [];
  const conflicts: SkillConflict[] = [];
  for (const group of grouped.values()) {
    group.sort((left, right) => left.precedence - right.precedence || left.skill.path.localeCompare(right.skill.path));
    const winner = group[0];
    if (!winner) continue;
    winners.push(winner);
    const shadowed = group.slice(1).map(({ skill }) => skill);
    if (shadowed.length) {
      conflicts.push({ name: winner.skill.name, winner: winner.skill, shadowed });
      warnings.push(`Skill conflict for ${winner.skill.name}: using ${winner.skill.path}; shadowed ${shadowed.map((skill) => skill.path).join(", ")}.`);
    }
  }

  const skills = winners
    .filter(({ skill }) => resolveSkillActivation({
      ref: skill.ref,
      globalDefaults: options.globalDefaults,
      projectOverrides: options.projectOverrides
    }).enabled)
    .map(({ skill }) => skill);
  return { skills, conflicts };
}

function buildSkillPrompt(skills: SkillDefinition[]): string {
  if (!skills.length) return "";
  const guidance = [
    "Skills use progressive disclosure: the list above holds metadata only, and the Skill tool loads a skill's full instructions on demand.",
    "When a task matches a listed skill, invoke the Skill tool as your first action instead of improvising a separate workflow.",
    "A /skill:name or $skill-name mention in the user's message is an explicit request: load that skill before replying about the task."
  ].join(" ");
  const render = (descriptionLimit: number, limit = skills.length): string => {
    const lines = skills.slice(0, limit).map((skill) => {
      const description = truncateChars(skill.description, descriptionLimit);
      return `- "${skill.name}": ${description}`;
    });
    const omitted = skills.length - limit;
    if (omitted > 0) lines.push(`(${String(omitted)} additional skills were omitted from this list. Use /skills to inspect all skills.)`);
    return ["<available_skills>", ...lines, "</available_skills>", guidance].join("\n");
  };
  for (const descriptionLimit of [maxSkillDescriptionChars, 300, 160, 80]) {
    const prompt = render(descriptionLimit);
    if (prompt.length <= maxInitialSkillPromptChars) return prompt;
  }
  let visible = skills.length;
  while (visible > 0 && render(80, visible).length > maxInitialSkillPromptChars) visible -= 1;
  return render(80, visible);
}

/** 能力分析完成后只读取选中 Skill 的正文；自动装配不等同于一次 Skill 工具调用。 */
export async function skillPromptForSelection(bundle: SkillBundle, selection?: CapabilitySelectionValue): Promise<string> {
  const selected = selectSkills(bundle, selection);
  if (!selected.length) return "";
  const sections = await Promise.all(selected.map(async (definition) => {
    const content = await readSkillFileFresh(definition.rootPath, definition.filePath, maxSkillInstructionBytes);
    let body = content;
    let metadata: SkillMetadata | undefined;
    try {
      const parsed = splitFrontmatter(content);
      metadata = parsed.frontmatter;
      if (path.basename(definition.filePath) === "SKILL.md" || parsed.frontmatter.name || parsed.frontmatter.description) {
        body = parsed.body;
      }
    } catch (error) {
      if (path.basename(definition.filePath) === "SKILL.md") throw error;
    }
    return renderSkillInstructions(
      definition,
      body.trim() || content.trim(),
      metadata,
      await listSkillResources(definition.filePath)
    );
  }));
  return [
    "<selected_skills>",
    "The following Skill instructions were selected during turn preparation. They are context, not evidence that a Skill tool was invoked.",
    ...sections,
    "</selected_skills>"
  ].join("\n\n");
}

export function skillPathsForSelection(bundle: SkillBundle, selection?: CapabilitySelectionValue): string[] {
  return selectSkills(bundle, selection).map((skill) => skill.path);
}

function selectSkills(bundle: SkillBundle, selection?: CapabilitySelectionValue): SkillDefinition[] {
  if (selection === undefined || selection === "auto" || selection === "all") return bundle.skills;
  if (selection === "none") return [];
  const selected = new Set(selection);
  return bundle.skills.filter((skill) => selected.has(skill.ref) || selected.has(skill.id) || selected.has(skill.name));
}

const invokeSkillArgsSchema = z.object({
  skill: z.string().trim().min(1)
});

type SkillBundleSource = SkillBundle | (() => SkillBundle);

export function createSkillTool(source: SkillBundleSource): Tool {
  return {
    name: "Skill",
    description: "Load the full instructions of an installed skill by name through progressive disclosure. Turn preparation may already include selected Skill instructions; use this tool when instructions are not present or when explicitly invoking another discovered skill. A real invocation is recorded as Skill usage and remains subject to normal permissions.",
    promptSnippet: "Load the full instructions for an available skill",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name exactly as listed in <available_skills>." }
      },
      required: ["skill"],
      additionalProperties: false
    },
    schema: invokeSkillArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = invokeSkillArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { isError: true as const, result: "Skill requires a skill name.", errorMessage: "Skill requires a skill name." };
      }
      const requested = parsed.data.skill;
      const bundle = currentBundle(source);
      const resolved = resolveSkill(bundle, requested);
      if (typeof resolved === "string") {
        const message = resolved;
        return { isError: true as const, result: message, errorMessage: message };
      }
      const definition = resolved;
      return {
        accesses: ToolAccesses.readFile(definition.filePath),
        display: { kind: "generic" as const, summary: `Skill ${definition.name}`, detail: truncateChars(definition.description, 200) },
        description: `Load skill instructions from ${definition.path}`,
        approvalRule: `Skill:${definition.name}`,
        async execute(): Promise<unknown> {
          const content = await readSkillFileFresh(definition.rootPath, definition.filePath, maxSkillInstructionBytes);
          let body = content;
          let metadata: SkillMetadata | undefined;
          try {
            const parsed = splitFrontmatter(content);
            metadata = parsed.frontmatter;
            if (path.basename(definition.filePath) === "SKILL.md" || parsed.frontmatter.name || parsed.frontmatter.description) {
              body = parsed.body;
            }
          } catch (error) {
            if (path.basename(definition.filePath) === "SKILL.md") throw error;
          }
          const resources = await listSkillResources(definition.filePath);
          return renderSkillInstructions(definition, body.trim() || content.trim(), metadata, resources);
        }
      };
    }
  };
}

/** Skill 工具结果模板：技能目录绝对路径是第三层资源（read_skill_resource/Read）的定位基准。 */
function renderSkillInstructions(
  skill: SkillDefinition,
  body: string,
  metadata: SkillMetadata | undefined,
  resources: SkillResourceEntry[]
): string {
  const directory = path.dirname(skill.filePath);
  const declarations = [
    metadata?.compatibility ? `Compatibility notes (not automatically verified): ${metadata.compatibility}` : undefined,
    metadata?.allowedTools?.length ? `Declared tools (normal permissions still apply): ${metadata.allowedTools.join(" ")}` : undefined
  ].filter((line): line is string => line !== undefined);
  const resourceLines = resources.length
    ? [
        "Resources in this skill directory (resolve them to absolute paths under the directory above):",
        ...resources.map((resource) => `- ${resource.path} (${resource.kind})`)
      ]
    : [];
  return [
    `# Skill: ${skill.name}`,
    "",
    `**Skill Directory:** \`${directory}\``,
    "",
    `> **IMPORTANT:** When this skill references any files (templates, scripts, references, assets), you MUST read them using absolute paths based on the skill directory above. For example, "references/guide.md" means \`${path.join(directory, "references", "guide.md")}\`.`,
    "",
    "---",
    "",
    ...declarations,
    ...(declarations.length ? [""] : []),
    body,
    "",
    "---",
    ...resourceLines,
    ...(resourceLines.length ? [""] : []),
    "Follow the instructions above for your response. Remember to use absolute paths when accessing files in the skill directory."
  ].join("\n");
}

const readSkillResourceArgsSchema = z.object({
  skill: z.string().trim().min(1),
  path: z.string().trim().min(1)
});

/** 第三级渐进式披露：只在 SKILL.md 明确需要时读取 references/scripts/assets。 */
export function createSkillResourceTool(source: SkillBundleSource): Tool {
  return {
    name: "read_skill_resource",
    description: "Read a text resource from an activated skill. Use a relative path listed by Skill.",
    promptSnippet: "Read a referenced text resource from an activated skill",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated skill name." },
        path: { type: "string", description: "Resource path relative to the skill directory." }
      },
      required: ["skill", "path"],
      additionalProperties: false
    },
    schema: readSkillResourceArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    async resolveExecution(args: unknown) {
      const parsed = readSkillResourceArgsSchema.safeParse(args);
      if (!parsed.success) {
        const message = "read_skill_resource requires a skill name and relative resource path.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const resolved = resolveSkill(currentBundle(source), parsed.data.skill);
      if (typeof resolved === "string") return { isError: true as const, result: resolved, errorMessage: resolved };
      let resourcePath: string;
      try {
        resourcePath = resolveSkillResourcePath(resolved, parsed.data.path);
        await assertReadableSkillResource(resolved, resourcePath);
      } catch (error) {
        const message = errorMessage(error);
        return { isError: true as const, result: message, errorMessage: message };
      }
      return {
        accesses: ToolAccesses.readFile(resourcePath),
        display: { kind: "file_io" as const, operation: "read" as const, path: parsed.data.path },
        description: `Read ${parsed.data.path} from skill ${resolved.name}`,
        approvalRule: `read_skill_resource:${resolved.name}:${parsed.data.path}`,
        async execute(): Promise<unknown> {
          return {
            skill: resolved.name,
            skillPath: resolved.path,
            path: parsed.data.path,
            content: await readSkillResourceFresh(resolved, resourcePath)
          };
        }
      };
    }
  };
}

function currentBundle(source: SkillBundleSource): SkillBundle {
  return typeof source === "function" ? source() : source;
}

const skillLookupArgsSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional()
});

/**
 * 本地技能搜索（介于元数据清单与 Skill 工具之间的发现层）。
 *
 * 清单只含本回合激活的技能；模型怀疑还有其他已装技能时用关键词在这里检索，
 * 纯本地打分、不联网也不调辅助模型，命中后仍经 Skill 工具加载全文。
 */
export function createSkillLookupTool(source: SkillBundleSource): Tool {
  return {
    name: "skill_lookup",
    description: "Search installed skills by name or description, including skills beyond the current <available_skills> list. Pure local keyword scoring; invoke the Skill tool with a returned name to load its full instructions.",
    promptSnippet: "Search installed skills beyond the active list",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability or task keywords to match against skill names and descriptions." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum matches to return. Defaults to 8." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: skillLookupArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = skillLookupArgsSchema.safeParse(args);
      if (!parsed.success) {
        const message = "skill_lookup requires a query.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const matches = rankSkillsByQuery(currentBundle(source).skills, parsed.data.query, parsed.data.limit ?? 8);
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic" as const, summary: "Search installed skills", detail: parsed.data.query },
        description: `Search installed skills for ${parsed.data.query}`,
        approvalRule: `skill_lookup(${parsed.data.query})`,
        async execute(): Promise<unknown> {
          return {
            query: parsed.data.query,
            found: matches.length,
            skills: matches,
            hint: matches.length
              ? "Invoke the Skill tool with a returned name to load its full instructions."
              : "No installed skill matched. Use skill_search to look for an installable one."
          };
        }
      };
    }
  };
}

/** token 覆盖数优先、命中权重次之（name 权重高于 description），同分按名字稳定排序。 */
function rankSkillsByQuery(
  skills: SkillDefinition[],
  query: string,
  limit: number
): Array<{ name: string; description: string; scope: SkillScope; path: string }> {
  const tokens = [...new Set(query.normalize("NFKC").toLowerCase().split(/\s+/u).filter((token) => token.length > 0))];
  if (!tokens.length) return [];
  const ranked = skills
    .map((skill) => {
      const name = skill.name.normalize("NFKC").toLowerCase();
      const description = skill.description.normalize("NFKC").toLowerCase();
      let covered = 0;
      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) {
          covered += 1;
          score += 10;
        } else if (description.includes(token)) {
          covered += 1;
          score += 2;
        }
      }
      return { skill, covered, score };
    })
    .filter((entry) => entry.covered > 0);
  ranked.sort((left, right) => right.covered - left.covered || right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  return ranked.slice(0, limit).map(({ skill }) => ({ name: skill.name, description: skill.description, scope: skill.scope, path: skill.path }));
}

/** 同名冲突已在加载时按优先级去重，技能名全局唯一，按名解析即可。 */
function resolveSkill(bundle: SkillBundle, requested: string): SkillDefinition | string {
  const selected = bundle.skills.find((skill) => skill.name.toLowerCase() === requested.toLowerCase());
  if (!selected) {
    const known = bundle.skills.map((skill) => `${skill.name} [${skill.path}]`).join(", ") || "none";
    return `Unknown skill: ${requested}. Available skills: ${known}.`;
  }
  return selected;
}

async function readSkillMetadata(projectRoot: string, candidate: SkillFileCandidate, scope: SkillScope, source: SkillRootSource): Promise<SkillDefinition> {
  // 绑定校验与展示路径都按候选自己的根计算，兼容全局根第一层软链指向其他受支持根的场景。
  const rootPath = candidate.rootPath;
  const content = await readBoundedSkillFile(rootPath, candidate, maxSkillMetadataBytes);
  const standardSkill = path.basename(candidate.path) === "SKILL.md";
  let frontmatter: SkillMetadata = {};
  let body = content;
  try {
    ({ frontmatter, body } = splitFrontmatter(content));
    if (!standardSkill && !frontmatter.name && !frontmatter.description) body = content;
  } catch (error) {
    if (standardSkill) throw error;
  }
  const fallbackName = deriveSkillName(candidate.path);
  const name = frontmatter.name ?? (standardSkill ? undefined : fallbackName);
  if (!name) throw new Error("SKILL.md frontmatter must include name.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`Invalid skill name: ${name}. Use 1-64 lowercase letters, numbers, and single hyphens.`);
  }
  if (standardSkill && path.basename(path.dirname(candidate.path)) !== name) {
    throw new Error(`Skill name ${name} must match its directory name.`);
  }
  if (standardSkill && !frontmatter.description) throw new Error("SKILL.md frontmatter must include description.");
  const rawDescription = (frontmatter.description ?? firstDescriptiveLine(body) ?? "No description provided.").trim();
  if (standardSkill && rawDescription.length > maxSkillDescriptionChars) {
    throw new Error(`Skill description exceeds ${String(maxSkillDescriptionChars)} characters.`);
  }
  const description = truncateChars(rawDescription, maxSkillDescriptionChars);
  if (!description) throw new Error("Skill description cannot be empty.");
  const relative = path.relative(rootPath, candidate.path);
  const ref = createSkillRef({ scope, name, projectRoot: scope === "project" ? projectRoot : undefined, source });
  return {
    ref,
    id: createSkillId(ref),
    name,
    description,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    allowedTools: frontmatter.allowedTools,
    metadata: frontmatter.metadata,
    path: scope === "global" ? globalDisplayPath(rootPath, relative) : scope === "builtin" ? `builtin/${relative}` : relative,
    filePath: candidate.path,
    rootPath,
    scope,
    source
  };
}

/** 全局技能展示路径：在 home 下时用 "~" 缩写，否则用实际绝对路径。 */
function globalDisplayPath(rootPath: string, relative: string): string {
  const fromHome = path.relative(os.homedir(), rootPath);
  if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return path.join("~", fromHome, relative);
  return path.join(rootPath, relative);
}

function sourceForProjectSkill(candidatePath: string | undefined, projectRoot: string): SkillRootSource {
  if (candidatePath === undefined) return "biny";
  const relative = path.relative(projectRoot, candidatePath).split(path.sep).join("/");
  return relative.startsWith(".agents/skills/") || relative === ".agents/skills" ? "agents" : "biny";
}

function sourceForGlobalRoot(configuredPath: string): SkillRootSource {
  if (path.resolve(configuredPath) === path.join(globalConfigDir(), "skills")) return "biny";
  const relative = path.relative(os.homedir(), path.resolve(configuredPath)).split(path.sep).join("/");
  return GLOBAL_SKILL_ROOT_CONVENTIONS.find((convention) => convention.relativePath === relative)?.source ?? "agents";
}

/** SKILL.md 用上级目录名作为技能名，普通 .md 用文件名主干。 */
function deriveSkillName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  if (path.basename(filePath) === "SKILL.md") return path.basename(path.dirname(filePath));
  return stem;
}

function splitFrontmatter(content: string): { frontmatter: SkillMetadata; body: string } {
  const parsed = parseSkillDocument(content);
  return { frontmatter: readSkillMetadataFields(parsed.frontmatter), body: parsed.body };
}

function firstDescriptiveLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed;
  }
  return undefined;
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

interface SkillResourceEntry {
  path: string;
  kind: "script" | "reference" | "asset" | "file";
  size: number;
}

/** 枚举标准资源目录，内容仍由 read_skill_resource 第三级按需读取。 */
async function listSkillResources(skillFilePath: string): Promise<SkillResourceEntry[]> {
  if (path.basename(skillFilePath) !== "SKILL.md") return [];
  const skillRoot = path.dirname(skillFilePath);
  const resources: SkillResourceEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (resources.length >= maxListedSkillResources) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (resources.length >= maxListedSkillResources) return;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile() || target === skillFilePath) continue;
      try {
        const stat = await fs.lstat(target, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || await escapesRoot(skillRoot, target)) continue;
        const relative = path.relative(skillRoot, target);
        const top = relative.split(path.sep, 1)[0]?.toLowerCase();
        resources.push({
          path: relative,
          kind: top === "scripts" ? "script" : top === "references" ? "reference" : top === "assets" ? "asset" : "file",
          size: Number(stat.size)
        });
      } catch {
        // 单个资源异常不影响 Skill 正文。
      }
    }
  };
  await visit(skillRoot);
  return resources;
}

function resolveSkillResourcePath(skill: SkillDefinition, resource: string): string {
  if (path.isAbsolute(resource)) throw new Error("Skill resource path must be relative.");
  const skillRoot = path.dirname(skill.filePath);
  const target = path.resolve(skillRoot, resource);
  const relative = path.relative(skillRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill resource escapes its skill directory: ${resource}`);
  }
  return target;
}

async function assertReadableSkillResource(skill: SkillDefinition, resourcePath: string): Promise<void> {
  const stat = await fs.lstat(resourcePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Skill resource cannot be a symbolic link: ${resourcePath}`);
  if (!stat.isFile()) throw new Error(`Skill resource is not a file: ${resourcePath}`);
  if (stat.nlink !== 1n) throw new Error(`Skill resources cannot be hardlinks: ${resourcePath}`);
  if (await escapesRoot(path.dirname(skill.filePath), resourcePath)) throw new Error(`Skill resource escapes its skill directory: ${resourcePath}`);
  if (stat.size > BigInt(maxSkillResourceBytes)) {
    throw new Error(`Skill resource exceeds ${String(maxSkillResourceBytes)} bytes: ${resourcePath}`);
  }
}

async function readSkillResourceFresh(skill: SkillDefinition, resourcePath: string): Promise<string> {
  await assertReadableSkillResource(skill, resourcePath);
  const stat = await fs.lstat(resourcePath, { bigint: true });
  const content = await readBoundedSkillFile(
    path.dirname(skill.filePath),
    { path: resourcePath, rootPath: path.dirname(skill.filePath), snapshot: skillSnapshot(stat) },
    maxSkillResourceBytes,
    true
  );
  if (content.includes("\0")) throw new Error(`Skill resource is binary and cannot be read as text: ${resourcePath}`);
  return content;
}

/** invoke 时重新校验并读取，允许文件在会话期间被正常编辑，但保持符号链接/硬链接/越界防御。 */
async function readSkillFileFresh(rootPath: string, filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Skill file cannot be a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Skill path is not a file: ${filePath}`);
  if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${filePath}`);
  if (await escapesRoot(rootPath, filePath)) throw new Error(`Skill file escapes its root: ${filePath}`);
  return await readBoundedSkillFile(rootPath, { path: filePath, rootPath, snapshot: skillSnapshot(stat) }, maxBytes, true);
}

async function collectSkillFiles(
  rootPath: string,
  target: string,
  files: SkillFileCandidate[],
  seen: Set<string>,
  allowDirectDirectorySymlink = false,
  allowedDirectorySymlinks: readonly string[] = []
): Promise<void> {
  if (files.length >= maxDiscoveredSkillCount) return;
  let stat;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return;
  }
  if (stat.isSymbolicLink()) {
    // 全局 Skill 根本身是用户主动登记的入口，允许其第一层目录软链指向
    // 已有技能目录可以作为直接入口；进入技能目录后仍禁止内部软链。
    if (!allowDirectDirectorySymlink || path.dirname(target) !== rootPath) return;
    let canonical: string;
    try {
      canonical = await fs.realpath(target);
    } catch {
      // 悬空或失效的软链只跳过自身，不能拖垮同根下的其他技能。
      return;
    }
    if (!allowedDirectorySymlinks.some((directory) => isPathInside(directory, canonical))) return;
    const linkedStat = await fs.lstat(canonical, { bigint: true });
    if (!linkedStat.isDirectory()) return;
    await collectSkillFiles(canonical, canonical, files, seen);
    return;
  }
  if (await escapesRoot(rootPath, target)) throw new Error(`Skill path escapes workspace: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${target}`);
    if (path.extname(target).toLowerCase() === ".md" && !seen.has(target)) {
      seen.add(target);
      files.push({ path: target, rootPath, snapshot: skillSnapshot(stat) });
    }
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  // 目录式技能只认 SKILL.md，避免把技能附带的文档一起当成独立技能。
  const skillEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
  if (skillEntry) {
    await collectSkillFiles(rootPath, path.join(target, skillEntry.name), files, seen);
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
    // 软链许可继续下传：是否放行由目标是否根的第一层（dirname 校验）决定。
    await collectSkillFiles(rootPath, path.join(target, entry.name), files, seen, allowDirectDirectorySymlink, allowedDirectorySymlinks);
    if (files.length >= maxDiscoveredSkillCount) return;
  }
}

async function resolveRootedSkillPath(rootPath: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(rootPath, configuredPath);
  const relative = path.relative(rootPath, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill path must stay inside workspace: ${configuredPath}`);
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return undefined;
    const canonical = await fs.realpath(absolutePath);
    if (path.relative(rootPath, canonical).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(rootPath, canonical))) {
      throw new Error(`Skill path escapes workspace: ${configuredPath}`);
    }
    if (canonical !== absolutePath) throw new Error(`Skill paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 全局技能根目录允许通过符号链接到达（如 macOS 的 /tmp），但内部仍禁止软链。 */
async function resolveGlobalSkillRoot(globalRoot: string): Promise<string | undefined> {
  try {
    const canonical = await fs.realpath(path.resolve(globalRoot));
    const stat = await fs.lstat(canonical);
    return stat.isDirectory() ? canonical : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function readBoundedSkillFile(
  rootPath: string,
  candidate: SkillFileCandidate,
  maxBytes: number,
  rejectOverflow = false
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate.path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error(`Skill file changed to a symbolic link before it could be read: ${candidate.path}`);
    throw error;
  }

  try {
    const initial = await assertSkillFileBinding(rootPath, candidate, handle);
    const chunks: Buffer[] = [];
    const readLimit = maxBytes + 4;
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    const current = await assertSkillFileBinding(rootPath, candidate, handle);
    if (!sameSkillSnapshot(initial, current)) throw new Error(`Skill file changed while it was being read: ${candidate.path}`);
    if (rejectOverflow && bytesRead > maxBytes) {
      throw new Error(`Skill file exceeds ${String(maxBytes)} bytes: ${candidate.path}`);
    }
    return truncateUtf8(Buffer.concat(chunks, bytesRead).toString("utf8"), maxBytes);
  } finally {
    await handle.close();
  }
}

async function assertSkillFileBinding(
  rootPath: string,
  candidate: SkillFileCandidate,
  handle: FileHandle
): Promise<SkillFileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(candidate.path, { bigint: true });
  const canonical = await fs.realpath(candidate.path);
  const relative = path.relative(rootPath, canonical);
  const snapshot = skillSnapshot(descriptorStat);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1n
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1n
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || canonical !== candidate.path
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !sameSkillSnapshot(candidate.snapshot, snapshot)
  ) {
    throw new Error(`Skill file changed after validation: ${candidate.path}`);
  }
  return snapshot;
}

function skillSnapshot(stat: BigIntStats): SkillFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    links: stat.nlink,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs
  };
}

function sameSkillSnapshot(left: SkillFileSnapshot, right: SkillFileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

async function escapesRoot(rootPath: string, target: string): Promise<boolean> {
  const canonical = await fs.realpath(target);
  const relative = path.relative(rootPath, canonical);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
