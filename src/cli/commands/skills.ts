/**
 * Skill 管理 CLI。
 *
 * CLI 与桌面共用仓库发现和受管安装器；版本切换不改变运行时的发现、激活与权限。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { defaultManagedSkillRoot } from "../../extensions/managedSkillSources.js";
import { parseSkillDocument } from "../../extensions/skillDocument.js";
import { discoverSkillRepositories, installDiscoveredSkill, searchSkillsSh, updateDiscoveredSkill } from "../../extensions/skillDiscovery.js";
import { readManagedSkillVersion, rollbackSkillVersion } from "../../extensions/skillVersions.js";
import { withGlobalConfigWriteLock } from "../../config/versioned.js";
import { loadSkills, type SkillBundle } from "../../extensions/skills.js";
import { createProjectSkillKey } from "../../extensions/skillRef.js";
import { loadConfig } from "../../config/loader.js";
import { scanSkillCatalog } from "../../extensions/skillCatalog.js";
import { diagnoseSkill } from "../../extensions/skillDiagnostics.js";
import { createFileConfigStore } from "../../config/store.js";

interface SkillOutputOptions {
  json?: boolean;
}

export function registerSkillCommands(program: Command, workspaceRoot: string): void {
  const command = program.command("skill").description("Search, install, and manage Skills");
  const execute = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };

  command.action(() => execute(async () => await skillListCommand(workspaceRoot)));
  command.command("list")
    .description("List loaded Skills")
    .option("--json", "print JSON")
    .action((options: SkillOutputOptions) => execute(async () => await skillListCommand(workspaceRoot, options)));
  command.command("search")
    .alias("find")
    .description("Search the Skill catalog")
    .argument("<query...>", "capability or task to search for")
    .option("--limit <count>", "maximum results", parsePositiveInteger)
    .option("--offset <count>", "pagination offset", parseNonNegativeInteger)
    .option("--json", "print JSON")
    .action((query: string[], options: SkillSearchOptions) => execute(async () => await skillSearchCommand(workspaceRoot, query.join(" "), options)));
  command.command("install")
    .description("Install a Skill from skills.sh or GitHub")
    .argument("<source>", "owner/repository, owner/repository@skill, or GitHub tree URL")
    .action((source: string) => execute(async () => await skillInstallCommand(source)));
  command.command("check")
    .description("Check declared Skill requirements without running scripts")
    .argument("[name]", "check one Skill, or all discovered Skills")
    .option("--json", "print JSON")
    .action((name: string | undefined, options: SkillOutputOptions) => execute(async () => {
      const catalog = await scanSkillCatalog({ projectRoots: [workspaceRoot] });
      const config = await createFileConfigStore(workspaceRoot).load();
      const skills = catalog.inventory.filter((skill) => name === undefined || skill.name === name || skill.ref === name);
      if (name !== undefined && !skills.length) throw new Error(`Skill not found: ${name}`);
      const reports = await Promise.all(skills.map((skill) => diagnoseSkill(skill, { config })));
      if (options.json) console.log(JSON.stringify({ reports, diagnostics: catalog.diagnostics }));
      else for (const report of reports) {
        console.log(`${report.name}: ${report.status}`);
        for (const check of report.checks) console.log(`  ${check.status}  ${check.subject}: ${check.message}`);
      }
      if (reports.some((report) => report.status === "blocked")) process.exitCode = 1;
    }));
  command.command("update")
    .description("Check for and update installed Skills")
    .argument("[name]", "one managed Skill, or all managed versions")
    .action((name: string | undefined) => execute(async () => await skillUpdateCommand(name)));
  command.command("rollback")
    .description("Restore the previous managed version without overwriting local edits")
    .argument("<name>", "Skill name")
    .action((name: string) => execute(async () => {
      const root = defaultManagedSkillRoot();
      const current = await readManagedSkillVersion(root, name);
      if (!current) throw new Error("This Skill has no managed version history.");
      const restored = await rollbackSkillVersion(root, name, current.id);
      console.log(`Restored ${name}: ${restored.revision}`);
    }));
  command.command("uninstall")
    .description("Remove an installed Skill")
    .argument("<name>", "Skill directory name")
    .action((name: string) => execute(async () => await skillUninstallCommand(name)));
  command.command("create")
    .description("Install a local SKILL.md")
    .argument("<name>", "Skill name")
    .requiredOption("--file <path>", "SKILL.md path, or - for stdin")
    .action((name: string, options: { file: string }) => execute(async () => await skillCreateCommand(name, options.file)));
}

interface SkillSearchOptions extends SkillOutputOptions {
  limit?: number;
  offset?: number;
}

/** Resolve discovery and activation from the same effective config as the runtime. */
async function loadWorkspaceSkills(workspaceRoot: string): Promise<SkillBundle> {
  const config = await loadConfig(workspaceRoot);
  return await loadSkills({
    workspaceRoot,
    projectPaths: config.extensions.skills,
    globalDefaults: config.extensions.skillDefaults,
    projectOverrides: config.extensions.skillProjectOverrides[createProjectSkillKey(workspaceRoot)]
  });
}

async function skillListCommand(workspaceRoot: string, options: SkillOutputOptions = {}): Promise<void> {
  const bundle = await loadWorkspaceSkills(workspaceRoot);
  const installations = (await Promise.all((await managedSkillNames()).map((name) => readManagedSkillVersion(defaultManagedSkillRoot(), name)))).filter(Boolean);
  const result = {
    skills: bundle.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      source: skill.source,
      path: skill.path,
      active: true
    })),
    installations,
    warnings: bundle.warnings,
    conflicts: bundle.conflicts.map((conflict) => ({
      name: conflict.name,
      winner: conflict.winner.path,
      shadowed: conflict.shadowed.map((skill) => skill.path)
    }))
  };
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.skills.length) {
    console.log("No Skills installed.");
  } else {
    for (const skill of result.skills) {
      console.log(`${skill.name}  [${skill.scope}]  ${skill.path}  ${skill.description}`);
    }
  }
  for (const warning of result.warnings) console.error(`Warning: ${warning}`);
}

async function skillSearchCommand(workspaceRoot: string, query: string, options: SkillSearchOptions = {}): Promise<void> {
  const bundle = await loadWorkspaceSkills(workspaceRoot);
  const result = await searchSkillsSh({
    query,
    limit: options.limit,
    offset: options.offset,
    installedNames: new Set(bundle.skills.map((skill) => skill.name))
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.skills.length) {
    console.log(`No Skills found for ${query}.`);
    return;
  }
  for (const skill of result.skills) {
    const installed = skill.installed ? " [installed]" : "";
    console.log(`${skill.name}${installed}  ${skill.repoOwner}/${skill.repoName}:${skill.directory}  installs=${String(skill.installs)}`);
  }
}

async function skillInstallCommand(source: string): Promise<void> {
  const url = source.startsWith("https://") ? new URL(source) : new URL(`https://github.com/${source}`);
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash) throw new Error("Use a GitHub repository or tree URL.");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const owner = parts[0];
  const [repositoryName, selectedName] = (parts[1] ?? "").replace(/\.git$/u, "").split("@");
  if (!owner || !repositoryName || (parts.length > 2 && (parts[2] !== "tree" || !parts[3]))) throw new Error("Use owner/repository@skill or a GitHub tree URL.");
  const branch = parts[3] ?? "main";
  const directory = parts.length > 4 ? parts.slice(4).join("/") : undefined;
  const result = await discoverSkillRepositories({ repositories: [{ owner, name: repositoryName, branch, enabled: true }] });
  const candidates = result.skills.filter((skill) => (!selectedName || skill.name === selectedName) && (!directory || skill.directory === directory));
  if (candidates.length !== 1) throw new Error(candidates.length ? `Choose a Skill with @name: ${candidates.map((skill) => skill.name).join(", ")}` : `Skill not found. ${result.warnings.join(" ")}`);
  const installed = await installDiscoveredSkill({ skill: candidates[0]! });
  console.log(`Installed ${installed.name}: ${installed.version.revision} at ${installed.installedPath}`);
  console.log(`Environment check: ${installed.diagnostic.status}. Run biny skill check ${installed.name} for details.`);
}

async function skillUpdateCommand(name?: string): Promise<void> {
  const names = name === undefined ? await managedSkillNames() : [name];
  let updated = 0;
  for (const candidate of names) {
    const current = await readManagedSkillVersion(defaultManagedSkillRoot(), candidate);
    if (!current) { if (name !== undefined) throw new Error("This Skill has no managed source version; install it through Biny first."); continue; }
    const result = await updateDiscoveredSkill({ name: candidate, expectedVersion: current.id });
    console.log(`${candidate}: ${result.version.id === current.id ? "unchanged" : result.version.revision} (${result.diagnostic.status})`);
    updated += 1;
  }
  if (!updated) console.log("No managed repository Skills found.");
}

async function skillUninstallCommand(name: string): Promise<void> {
  assertSkillDirectoryName(name);
  const root = defaultManagedSkillRoot();
  await withGlobalConfigWriteLock(root, async () => {
    const target = path.join(root, name);
    if (!await pathExists(target)) throw new Error(`Skill not found: ${name}`);
    await fs.rm(target, { recursive: true });
    // 旧版本保留为归档，已开始的调用仍持有它们的真实路径。
  });
  console.log(`Uninstalled from Biny: ${name}`);
}

async function managedSkillNames(): Promise<string[]> {
  try { return (await fs.readdir(defaultManagedSkillRoot())).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64); }
  catch (error) { if (isNotFound(error)) return []; throw error; }
}

async function skillCreateCommand(name: string, source: string): Promise<void> {
  assertSkillDirectoryName(name);
  const content = source === "-" ? await readStdin() : await fs.readFile(source, "utf8");
  const parsed = parseSkillDocument(content);
  if (parsed.frontmatter.name !== name || typeof parsed.frontmatter.description !== "string" || !parsed.frontmatter.description.trim()) {
    throw new Error("SKILL.md frontmatter must contain matching name and a non-empty description.");
  }
  const target = path.join(defaultManagedSkillRoot(), name);
  await fs.mkdir(defaultManagedSkillRoot(), { recursive: true });
  await fs.mkdir(target);
  try {
    await fs.writeFile(path.join(target, "SKILL.md"), content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  console.log(`Installed personal Skill "${name}" at ${target}`);
}

function assertSkillDirectoryName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid Skill directory name: ${name}`);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError(`Expected a positive integer, got: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got: ${value}`);
  return parsed;
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { content += chunk; });
    process.stdin.once("end", () => resolve(content));
    process.stdin.once("error", reject);
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
