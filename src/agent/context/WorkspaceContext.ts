import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";
import type { AgentMessage } from "../core/types.js";
import { messageText } from "../modelMessages.js";
import { collectProjectContext } from "../../project/ProjectContext.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import type { LoadedInstruction, ProjectSnapshot, RecentWorkspaceActivity, RepoMapEntry, RepoMapRole, WorkspaceTurnData } from "./types.js";

const instructionFileNames = ["AGENTS.override.md", "AGENTS.md"];
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"]);
const maxRepoFiles = 600;
const maxSourceChars = 120_000;

export interface WorkspaceContextStatus {
  loadedInstructions: string[];
  instructionBytes: number;
  snapshotRefreshedAt?: string;
  snapshotDirty: boolean;
  repoMapRefreshedAt?: string;
  repoMapDirty: boolean;
  repoMapEntries: number;
  activePaths: string[];
  recentActivity: RecentWorkspaceActivity;
}

export class WorkspaceContext {
  private readonly canonicalWorkspaceRoot: string;
  private readonly loadedInstructions: LoadedInstruction[] = [];
  private readonly visitedInstructionDirectories = new Set<string>();
  private readonly activePaths: string[] = [];
  private readonly recentSummaries: string[] = [];
  private instructionBytes = 0;
  private snapshot: ProjectSnapshot | undefined;
  private snapshotDirty = true;
  private repoEntries: RepoMapEntry[] = [];
  private repoEntryCache = new Map<string, { fingerprint: string; entry: RepoMapEntry }>();
  private repoMapRefreshedAt: string | undefined;
  private repoMapDirty = true;
  private initialized = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly ignore: string[],
    private readonly instructionMaxBytes: number,
    /** 全局指令文件；传 undefined 关闭，默认 ~/.config/biny/AGENTS.md。 */
    private readonly globalInstructionFile: string | undefined = path.join(globalConfigDir(), "AGENTS.md")
  ) {
    this.canonicalWorkspaceRoot = resolveWorkspaceDirectory(workspaceRoot, ".", []);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    signal?.throwIfAborted();
    // 全局指令先于项目指令加载：全局是基线，项目级内容在其后可以细化覆盖。
    await this.loadGlobalInstructions(signal);
    await Promise.all([
      this.loadInstructionDirectory(this.workspaceRoot, signal),
      this.refreshSnapshot(signal),
      this.refreshRepoMap(signal)
    ]);
    signal?.throwIfAborted();
    this.initialized = true;
  }

  async prepareTurn(input: string, signal?: AbortSignal): Promise<WorkspaceTurnData> {
    await this.initialize(signal);
    signal?.throwIfAborted();
    const explicitPaths = extractPathReferences(input);
    // 指令是下一回合的输入；不能把已访问目录（包括没有指令的目录）永久缓存。
    this.loadedInstructions.length = 0;
    this.visitedInstructionDirectories.clear();
    this.instructionBytes = 0;
    await this.loadGlobalInstructions(signal);
    await this.loadInstructionDirectory(this.workspaceRoot, signal);
    await this.loadInstructionsForPaths([...explicitPaths, ...this.activePaths], signal);
    const [snapshot, repoMapCandidates] = await Promise.all([
      this.refreshSnapshot(signal),
      this.findRepoMapCandidates(input, signal)
    ]);
    signal?.throwIfAborted();
    return {
      instructions: this.loadedInstructions.map((instruction) => ({ ...instruction })),
      snapshot,
      explicitPaths,
      recentActivity: this.recentActivity(),
      repoMapCandidates
    };
  }

  observeToolResult(tool: string, args: unknown, result: unknown): void {
    const paths = collectPaths(args, result);
    for (const filePath of paths) addUnique(this.activePaths, filePath, 24);
    addUnique(this.recentSummaries, summarizeToolResult(tool, paths, result), 12);
    if (
      tool === "Bash"
      || (["Write", "Edit"].includes(tool) && !isFailure(result))
    ) {
      this.snapshotDirty = true;
      this.repoMapDirty = true;
    }
  }

  restoreFromHistory(messages: AgentMessage[]): void {
    this.activePaths.splice(0, this.activePaths.length);
    this.recentSummaries.splice(0, this.recentSummaries.length);
    for (const message of messages) {
      for (const filePath of extractPathReferences(messageText(message))) addUnique(this.activePaths, filePath, 24);
    }
  }

  /** 标记项目快照与 repo map 为脏；工作区在会话外被改动（如切分支）时让下一回合重新扫描。 */
  invalidateSnapshot(): void {
    this.snapshotDirty = true;
    this.repoMapDirty = true;
  }

  status(): WorkspaceContextStatus {
    return {
      loadedInstructions: this.loadedInstructions.map((instruction) => instruction.path),
      instructionBytes: this.instructionBytes,
      snapshotRefreshedAt: this.snapshot?.refreshedAt,
      snapshotDirty: this.snapshotDirty,
      repoMapRefreshedAt: this.repoMapRefreshedAt,
      repoMapDirty: this.repoMapDirty,
      repoMapEntries: this.repoEntries.length,
      activePaths: [...this.activePaths],
      recentActivity: this.recentActivity()
    };
  }

  private async refreshSnapshot(signal?: AbortSignal): Promise<ProjectSnapshot> {
    signal?.throwIfAborted();
    if (!this.snapshot || this.snapshotDirty) {
      const context = await collectProjectContext(this.workspaceRoot, this.ignore, signal);
      signal?.throwIfAborted();
      this.snapshot = {
        context,
        refreshedAt: new Date().toISOString(),
        revision: (this.snapshot?.revision ?? 0) + 1
      };
      this.snapshotDirty = false;
    }
    return this.snapshot;
  }

  private async refreshRepoMap(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.repoMapDirty) return;
    const files = (await scanWorkspaceFiles(this.workspaceRoot, this.ignore, maxRepoFiles, signal)).sort((left, right) => left.localeCompare(right));
    const nextCache = new Map<string, { fingerprint: string; entry: RepoMapEntry }>();
    const entries = await Promise.all(files.map(async (filePath) => {
      // 仍扫描目录来发现新增和删除；只复用元数据未变的源码提取结果。
      let fingerprint: string;
      try {
        const resolved = resolveWorkspacePath(this.workspaceRoot, filePath, this.ignore);
        const stat = await fs.stat(resolved, { bigint: true });
        fingerprint = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      } catch {
        signal?.throwIfAborted();
        return { path: filePath, role: classifyRepoRole(filePath), symbols: [], imports: [], exports: [] };
      }
      const cached = this.repoEntryCache.get(filePath);
      const entry = cached?.fingerprint === fingerprint
        ? cached.entry
        : await buildRepoMapEntry(this.workspaceRoot, this.ignore, filePath, signal);
      if (entry) nextCache.set(filePath, { fingerprint, entry });
      return entry ?? { path: filePath, role: classifyRepoRole(filePath), symbols: [], imports: [], exports: [] };
    }));
    signal?.throwIfAborted();
    this.repoEntries = entries;
    this.repoEntryCache = nextCache;
    this.repoMapRefreshedAt = new Date().toISOString();
    this.repoMapDirty = false;
  }

  private async findRepoMapCandidates(query: string, signal?: AbortSignal): Promise<RepoMapEntry[]> {
    await this.refreshRepoMap(signal);
    signal?.throwIfAborted();
    const active = new Set(this.activePaths);
    const terms = tokenize(query);
    return this.repoEntries
      .map((entry) => ({ entry, score: scoreRepoEntry(entry, active, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
      .slice(0, 12)
      .map((item) => item.entry);
  }

  private async loadInstructionsForPaths(filePaths: string[], signal?: AbortSignal): Promise<void> {
    const directories = new Set<string>();
    for (const filePath of filePaths) {
      signal?.throwIfAborted();
      const absolutePath = this.toWorkspacePath(filePath);
      if (!absolutePath) continue;
      let currentDirectory = path.dirname(absolutePath);
      const chain: string[] = [];
      while (isInsideWorkspace(this.canonicalWorkspaceRoot, currentDirectory)) {
        chain.unshift(currentDirectory);
        if (currentDirectory === this.canonicalWorkspaceRoot) break;
        currentDirectory = path.dirname(currentDirectory);
      }
      for (const directory of chain) directories.add(directory);
    }
    for (const directory of [...directories].sort((left, right) => left.localeCompare(right))) {
      await this.loadInstructionDirectory(directory, signal);
    }
  }

  private async loadGlobalInstructions(signal?: AbortSignal): Promise<void> {
    const filePath = this.globalInstructionFile;
    if (!filePath) return;
    signal?.throwIfAborted();
    try {
      // 全局文件在 home 下、不在 workspace 防御边界内，这里单独拒绝软链。
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
    } catch {
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(filePath, { encoding: "utf8", signal });
    } catch {
      // 全局指令是辅助上下文；不可读时跳过，取消信号仍需正常传播。
      signal?.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    const selectedContent = truncateUtf8(content, this.instructionMaxBytes - this.instructionBytes);
    const bytes = Buffer.byteLength(selectedContent, "utf8");
    if (!selectedContent || !bytes) return;
    const fromHome = path.relative(os.homedir(), filePath);
    this.loadedInstructions.push({
      path: fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome) ? path.join("~", fromHome) : filePath,
      content: selectedContent,
      bytes
    });
    this.instructionBytes += bytes;
  }

  private async loadInstructionDirectory(directory: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const canonicalDirectory = this.toWorkspaceDirectory(directory);
    if (!canonicalDirectory || this.visitedInstructionDirectories.has(canonicalDirectory) || this.instructionBytes >= this.instructionMaxBytes) return;
    const filePath = await findInstructionFile(this.workspaceRoot, canonicalDirectory, this.ignore, signal);
    if (!filePath) {
      this.visitedInstructionDirectories.add(canonicalDirectory);
      return;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, { encoding: "utf8", signal });
    } catch {
      // 项目指令不可读时不能阻断整个发送链路；真实文件访问仍由工具层明确报错。
      signal?.throwIfAborted();
      this.visitedInstructionDirectories.add(canonicalDirectory);
      return;
    }
    signal?.throwIfAborted();
    const selectedContent = truncateUtf8(content, this.instructionMaxBytes - this.instructionBytes);
    const bytes = Buffer.byteLength(selectedContent, "utf8");
    if (!selectedContent || !bytes) return;
    this.loadedInstructions.push({
      path: toWorkspaceRelative(this.workspaceRoot, filePath),
      content: selectedContent,
      bytes
    });
    this.instructionBytes += bytes;
    this.visitedInstructionDirectories.add(canonicalDirectory);
  }

  private toWorkspacePath(filePath: string): string | undefined {
    try {
      return resolveWorkspacePath(this.workspaceRoot, filePath, this.ignore);
    } catch {
      return undefined;
    }
  }

  private toWorkspaceDirectory(directory: string): string | undefined {
    try {
      return resolveWorkspaceDirectory(this.workspaceRoot, toWorkspaceRelative(this.workspaceRoot, directory), this.ignore);
    } catch {
      return undefined;
    }
  }

  private recentActivity(): RecentWorkspaceActivity {
    return { paths: [...this.activePaths], summaries: [...this.recentSummaries] };
  }
}

export function formatRepoMapCandidates(entries: RepoMapEntry[]): string {
  if (!entries.length) return "(no deterministic RepoMap candidates)";
  return entries.map((entry) => {
    const details = [
      entry.role,
      entry.symbols.length ? `symbols: ${entry.symbols.join(", ")}` : "",
      entry.imports.length ? `imports: ${entry.imports.join(", ")}` : "",
      entry.exports.length ? `exports: ${entry.exports.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    return `- ${entry.path}${details ? ` (${details})` : ""}`;
  }).join("\n");
}

export function extractPathReferences(value: string): string[] {
  return [...new Set(value.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|html)/g) ?? [])].slice(0, 24);
}

async function buildRepoMapEntry(workspaceRoot: string, ignore: string[], filePath: string, signal?: AbortSignal): Promise<RepoMapEntry | undefined> {
  signal?.throwIfAborted();
  const role = classifyRepoRole(filePath);
  if (!codeExtensions.has(path.extname(filePath).toLowerCase())) {
    return { path: filePath, role, symbols: [], imports: [], exports: [] };
  }
  try {
    const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, ignore);
    const handle = await fs.open(resolvedPath, "r");
    let content: string;
    try {
      // RepoMap 只提取文件头，避免大文件为了 slice 先被完整读入内存。
      const buffer = Buffer.alloc(Math.min((await handle.stat()).size, maxSourceChars * 4));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal?.throwIfAborted();
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      content = buffer.subarray(0, bytesRead).toString("utf8").slice(0, maxSourceChars);
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    return {
      path: filePath,
      role,
      symbols: extractSymbols(content),
      imports: extractImports(content),
      exports: extractExports(content)
    };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function classifyRepoRole(filePath: string): RepoMapRole {
  const normalized = filePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(baseName) || normalized.includes("/tests/")) return "test";
  if (["index.ts", "index.tsx", "main.ts", "main.tsx", "cli.ts", "server.ts"].includes(baseName)) return "entry";
  if (["package.json", "tsconfig.json", "vite.config.ts", "next.config.js"].includes(baseName)) return "config";
  if (normalized.startsWith("src/")) return "source";
  return "other";
}

function extractSymbols(content: string): string[] {
  const matches = content.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  return unique([...matches].map((match) => match[1]).filter((value): value is string => Boolean(value))).slice(0, 24);
}

function extractImports(content: string): string[] {
  const fromImports = [...content.matchAll(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  const requires = [...content.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  return unique([...fromImports, ...requires].filter((value): value is string => Boolean(value))).slice(0, 16);
}

function extractExports(content: string): string[] {
  const declarations = [...content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  const lists = [...content.matchAll(/\bexport\s*{([^}]+)}/g)]
    .flatMap((match) => match[1]?.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]?.trim()) ?? []);
  return unique([...declarations, ...lists].filter((value): value is string => Boolean(value))).slice(0, 24);
}

function scoreRepoEntry(entry: RepoMapEntry, activePaths: Set<string>, terms: string[]): number {
  let score = activePaths.has(entry.path) ? 80 : 0;
  if (entry.role === "entry") score += 8;
  if (!terms.length) return score + (entry.role === "source" ? 2 : 1);
  const pathText = entry.path.toLowerCase();
  const symbolText = entry.symbols.join(" ").toLowerCase();
  const importText = entry.imports.join(" ").toLowerCase();
  for (const term of terms) {
    if (pathText.includes(term)) score += 12;
    if (symbolText.includes(term)) score += 10;
    if (importText.includes(term)) score += 4;
  }
  return score;
}

function collectPaths(args: unknown, result: unknown): string[] {
  const paths: string[] = [];
  collectRecordPaths(args, paths);
  collectRecordPaths(result, paths);
  return [...new Set(paths)].slice(0, 24);
}

function collectRecordPaths(value: unknown, paths: string[]): void {
  if (!isRecord(value)) return;
  if (typeof value.path === "string") addUnique(paths, value.path, 24);
  if (Array.isArray(value.files)) {
    for (const file of value.files) if (typeof file === "string") addUnique(paths, file, 24);
  }
  if (Array.isArray(value.matches)) {
    for (const match of value.matches) {
      if (isRecord(match) && typeof match.path === "string") addUnique(paths, match.path, 24);
    }
  }
}

function summarizeToolResult(tool: string, paths: string[], result: unknown): string {
  const target = paths.length ? ` ${paths.slice(0, 4).join(", ")}` : "";
  return isFailure(result) ? `${tool} failed${target}` : `${tool} completed${target}`;
}

function isFailure(value: unknown): boolean {
  return isRecord(value) && (typeof value.error === "string" || value.status === "denied");
}

async function findInstructionFile(workspaceRoot: string, directory: string, ignore: string[], signal?: AbortSignal): Promise<string | undefined> {
  const relativeDirectory = toWorkspaceRelative(workspaceRoot, directory);
  for (const fileName of instructionFileNames) {
    signal?.throwIfAborted();
    let filePath: string;
    try {
      filePath = resolveWorkspacePath(workspaceRoot, path.join(relativeDirectory, fileName), ignore);
    } catch {
      continue;
    }
    try {
      if ((await fs.stat(filePath)).isFile()) return filePath;
    } catch (error) {
      if (isNotFound(error)) continue;
      signal?.throwIfAborted();
      return undefined;
    }
  }
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  const targetBytes = maxBytes - suffixBytes;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= targetBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function tokenize(value: string): string[] {
  return unique(value.toLowerCase().split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2)).slice(0, 12);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function addUnique(values: string[], value: string, limit: number): void {
  if (!value || values.includes(value)) return;
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
