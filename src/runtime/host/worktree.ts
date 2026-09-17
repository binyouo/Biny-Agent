/**
 * Runtime Host 的 git worktree 子系统。
 *
 * worktree 是代码隔离层，session JSONL 和运行账本仍归 persistenceRoot。所有自动清理都
 * 只允许处理“干净且已合并”的树；只要无法证明安全，就登记为 orphaned/kept，绝不删除用户工作。
 * worktree 检出目录仍是项目本地显式产物，生命周期登记则放在全局运行目录。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listSessionCatalog, readSessionCatalogRecord } from "../../session/catalog.js";
import { agentDir, listSessionFiles } from "../../session/store.js";
import type { RuntimeHostFactoryOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const registryVersion = 1 as const;
const worktreeDirectoryName = "worktrees";
const worktreePrefix = "wt-";

export type WorktreeLifecycleStatus = "active" | "merged" | "conflicted" | "orphaned" | "kept";

export interface WorktreeRecord {
  version: typeof registryVersion;
  sessionId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  createdAt: string;
  status: WorktreeLifecycleStatus;
  mergeStrategy?: "merge" | "squash";
  /** merge 成功后基线分支的新 HEAD；squash 清理不能用源分支祖先关系证明。 */
  mergedCommit?: string;
}

export interface WorktreeMergeResult {
  record: WorktreeRecord;
  cleanup: {
    status: "not-requested" | "completed" | "failed";
    error?: string;
  };
}

export interface WorktreeStatusView extends WorktreeRecord {
  exists: boolean;
  dirty: boolean;
  mergedIntoBase: boolean;
}

export interface WorktreeReconcileResult {
  available: boolean;
  records: WorktreeRecord[];
  removed: string[];
  orphaned: string[];
}

export class WorktreeUnavailableError extends Error {
  readonly code = "worktree_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "WorktreeUnavailableError";
  }
}

export class WorktreeDirtyError extends Error {
  readonly code = "worktree_dirty";

  constructor(readonly worktreePath: string) {
    super(`Worktree ${worktreePath} contains uncommitted changes; it was kept.`);
    this.name = "WorktreeDirtyError";
  }
}

export class WorktreeUnmergedError extends Error {
  readonly code = "worktree_unmerged";

  constructor(readonly sessionId: string, readonly branch: string) {
    super(`Worktree ${sessionId} has unmerged commits on ${branch}; merge it or remove it without deleting the branch.`);
    this.name = "WorktreeUnmergedError";
  }
}

export class WorktreeMergeConflictError extends Error {
  readonly code = "worktree_merge_conflict";

  constructor(readonly sessionId: string, readonly worktreePath: string) {
    super(`Worktree ${sessionId} could not be merged automatically; resolve the conflict in ${worktreePath}.`);
    this.name = "WorktreeMergeConflictError";
  }
}

export class WorktreeBaseBranchMismatchError extends Error {
  readonly code = "worktree_base_branch_mismatch";

  constructor(
    readonly sessionId: string,
    readonly expectedBranch: string,
    readonly actualBranch: string
  ) {
    super(`Worktree ${sessionId} was created from ${expectedBranch}, but the main checkout is now on ${actualBranch}; merge was not started.`);
    this.name = "WorktreeBaseBranchMismatchError";
  }
}

export class WorktreeManager {
  readonly worktreeDirectory: string;
  readonly registryPath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly repoRoot: string,
    readonly persistenceRoot: string
  ) {
    this.repoRoot = path.resolve(repoRoot);
    this.persistenceRoot = path.resolve(persistenceRoot);
    this.worktreeDirectory = path.join(this.repoRoot, ".biny", worktreeDirectoryName);
    this.registryPath = path.join(agentDir(this.persistenceRoot), "runs", "worktrees.json");
  }

  async ensure(sessionId: string): Promise<WorktreeRecord> {
    return await this.enqueue(async () => {
      const records = await this.readRecords();
      const existing = records.find((record) => record.sessionId === sessionId);
      if (existing && await pathExists(existing.worktreePath)) return existing;
      if (existing) records.splice(records.indexOf(existing), 1);

      const baseBranch = await this.currentBranch();
      const baseCommit = (await this.git(["rev-parse", "HEAD"])).trim();
      await this.ensureWorktreeDirectory();
      const prefix = `${worktreePrefix}${sessionId.slice(0, 8)}`;
      let suffix = 0;
      let branch = `biny/${prefix}`;
      let worktreePath = path.join(this.worktreeDirectory, prefix);
      while (records.some((record) => record.branch === branch || record.worktreePath === worktreePath) || await this.branchExists(branch) || await pathExists(worktreePath)) {
        suffix += 1;
        branch = `biny/${prefix}-${String(suffix)}`;
        worktreePath = path.join(this.worktreeDirectory, `${prefix}-${String(suffix)}`);
      }
      await this.git(["worktree", "add", "-b", branch, worktreePath, baseCommit], this.repoRoot, 30_000);
      const record: WorktreeRecord = {
        version: registryVersion,
        sessionId,
        worktreePath,
        branch,
        baseBranch,
        baseCommit,
        createdAt: new Date().toISOString(),
        status: "active"
      };
      records.push(record);
      await this.writeRecords(records);
      return record;
    });
  }

  async get(sessionId: string): Promise<WorktreeRecord | undefined> {
    return (await this.readRecords()).find((record) => record.sessionId === sessionId);
  }

  async list(): Promise<WorktreeRecord[]> {
    return await this.readRecords();
  }

  /** 判断当前仓库能否创建隔离工作树；不可用时普通 shared session 仍可继续运行。 */
  async isAvailable(): Promise<boolean> {
    try {
      await this.currentBranch();
      return true;
    } catch (error) {
      if (error instanceof WorktreeUnavailableError) return false;
      throw error;
    }
  }

  async runtimeFactoryOptions(sessionId: string): Promise<RuntimeHostFactoryOptions | undefined> {
    const record = await this.get(sessionId);
    if (record === undefined) return undefined;
    let sessionFileExists = false;
    try {
      sessionFileExists = (await listSessionFiles(this.persistenceRoot)).includes(`${sessionId}.jsonl`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return { workspaceRoot: record.worktreePath, sessionId, fresh: !sessionFileExists, isolation: "worktree" };
  }

  async status(sessionId?: string): Promise<WorktreeStatusView[]> {
    const records = await this.readRecords();
    const selected = sessionId === undefined ? records : records.filter((record) => record.sessionId === sessionId);
    return await Promise.all(selected.map(async (record) => {
      const exists = await pathExists(record.worktreePath);
      const dirty = exists ? Boolean((await this.git(["status", "--porcelain", "--ignore-submodules=all"], record.worktreePath)).trim()) : false;
      const mergedIntoBase = exists && await this.isMergedIntoBase(record);
      return { ...record, exists, dirty, mergedIntoBase };
    }));
  }

  async merge(
    sessionId: string,
    options: { strategy?: "merge" | "squash"; deleteAfter?: boolean } = {}
  ): Promise<WorktreeMergeResult> {
    return await this.enqueue(async () => {
      const records = await this.readRecords();
      const record = records.find((candidate) => candidate.sessionId === sessionId);
      if (!record) throw new Error(`No worktree is registered for session ${sessionId}.`);
      if (!(await pathExists(record.worktreePath))) throw new WorktreeUnavailableError(`Worktree path is missing: ${record.worktreePath}`);
      if ((await this.git(["status", "--porcelain", "--ignore-submodules=all"], record.worktreePath)).trim()) {
        throw new WorktreeDirtyError(record.worktreePath);
      }
      if ((await this.git(["status", "--porcelain", "--ignore-submodules=all"])).trim()) {
        throw new Error("The main checkout has uncommitted changes; merge was not started.");
      }
      const currentBranch = await this.currentBranch();
      if (currentBranch !== record.baseBranch) {
        throw new WorktreeBaseBranchMismatchError(sessionId, record.baseBranch, currentBranch);
      }
      const strategy = options.strategy ?? "merge";
      try {
        if (strategy === "squash") {
          await this.git(["merge", "--squash", record.branch], this.repoRoot, 30_000);
          await this.git(["commit", "-m", `Merge ${record.branch}`], this.repoRoot, 30_000);
        } else {
          await this.git(["merge", "--no-ff", record.branch, "-m", `Merge ${record.branch}`], this.repoRoot, 30_000);
        }
      } catch (_error) {
        await this.git(["merge", "--abort"], this.repoRoot, 10_000).catch(() => undefined);
        record.status = "conflicted";
        await this.writeRecords(records);
        throw new WorktreeMergeConflictError(sessionId, record.worktreePath);
      }
      record.status = "merged";
      record.mergeStrategy = strategy;
      record.mergedCommit = (await this.git(["rev-parse", "HEAD"])).trim();
      await this.writeRecords(records);
      const mergedRecord = { ...record };
      if (options.deleteAfter !== true) {
        return { record: mergedRecord, cleanup: { status: "not-requested" } };
      }
      try {
        await this.removeRecord(records, record, true);
        return { record: mergedRecord, cleanup: { status: "completed" } };
      } catch (error) {
        return {
          record: mergedRecord,
          cleanup: {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          }
        };
      }
    });
  }

  async remove(sessionId: string, deleteBranch = false): Promise<void> {
    await this.enqueue(async () => {
      const records = await this.readRecords();
      const record = records.find((candidate) => candidate.sessionId === sessionId);
      if (!record) return;
      await this.removeRecord(records, record, deleteBranch);
    });
  }

  /** 启动时对注册表、git worktree 和 session catalog 做三方对账。 */
  async reconcile(): Promise<WorktreeReconcileResult> {
    return await this.enqueue(async () => {
      const records = await this.readRecords();
      if (!(await this.isRepository())) return { available: false, records, removed: [], orphaned: [] };
      const gitWorktrees = await this.listGitWorktrees();
      const removed: string[] = [];
      const orphaned: string[] = [];
      const present = new Map(gitWorktrees.map((worktree) => [worktree.path, worktree]));
      for (const record of [...records]) {
        if (!present.has(path.resolve(record.worktreePath))) {
          records.splice(records.indexOf(record), 1);
          removed.push(record.sessionId);
          continue;
        }
      }

      const knownPaths = new Set(records.map((record) => path.resolve(record.worktreePath)));
      for (const worktree of gitWorktrees) {
        if (worktree.path === path.resolve(this.repoRoot) || knownPaths.has(worktree.path) || !isWithin(this.worktreeDirectory, worktree.path)) continue;
        const sessionId = `orphan:${path.basename(worktree.path)}`;
        records.push({
          version: registryVersion,
          sessionId,
          worktreePath: worktree.path,
          branch: worktree.branch,
          baseBranch: await this.currentBranch(),
          baseCommit: worktree.head,
          createdAt: new Date().toISOString(),
          status: "orphaned"
        });
        orphaned.push(sessionId);
      }

      const catalogIds = await this.catalogSessionIds();
      for (const record of [...records]) {
        if (record.status === "kept" || record.sessionId.startsWith("orphan:")) continue;
        if (catalogIds.has(record.sessionId) || await this.catalogRecordExists(record.sessionId)) continue;
        const clean = await this.isClean(record.worktreePath);
        const merged = clean && await this.isMergedIntoBase(record);
        if (merged) {
          await this.removeRecord(records, record, true);
          removed.push(record.sessionId);
        } else {
          record.status = "orphaned";
          orphaned.push(record.sessionId);
        }
      }
      await this.writeRecords(records);
      return { available: true, records, removed, orphaned };
    });
  }

  private async removeRecord(records: WorktreeRecord[], record: WorktreeRecord, deleteBranch: boolean): Promise<void> {
    const branchExists = deleteBranch && await this.branchExists(record.branch);
    const squashMerged = branchExists && record.mergeStrategy === "squash" && await this.hasSquashMergeEvidence(record);
    if (branchExists && !squashMerged && !(await this.isBranchAncestor(record.branch, record.baseBranch))) {
      throw new WorktreeUnmergedError(record.sessionId, record.branch);
    }
    if (await pathExists(record.worktreePath)) {
      if (!(await this.isClean(record.worktreePath))) {
        record.status = "kept";
        await this.writeRecords(records);
        throw new WorktreeDirtyError(record.worktreePath);
      }
      await this.git(["worktree", "remove", record.worktreePath], this.repoRoot, 30_000);
    }
    if (branchExists) {
      // squash 不会让源分支成为基线祖先；仅在已记录的 squash commit 仍位于基线时强制删源分支。
      await this.git(["branch", squashMerged ? "-D" : "-d", record.branch], this.repoRoot, 10_000);
    }
    records.splice(records.indexOf(record), 1);
    await this.writeRecords(records);
  }

  private async currentBranch(): Promise<string> {
    if (!(await this.isRepository())) throw new WorktreeUnavailableError("The workspace is not a git repository.");
    const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (!branch) throw new WorktreeUnavailableError("Worktree isolation requires a named base branch; the main checkout is detached.");
    return branch;
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async isBranchAncestor(branch: string, baseBranch: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", branch, baseBranch]);
      return true;
    } catch {
      return false;
    }
  }

  private async isMergedIntoBase(record: WorktreeRecord): Promise<boolean> {
    return await this.isBranchAncestor(record.branch, record.baseBranch) || await this.hasSquashMergeEvidence(record);
  }

  private async hasSquashMergeEvidence(record: WorktreeRecord): Promise<boolean> {
    return record.status === "merged"
      && record.mergeStrategy === "squash"
      && record.mergedCommit !== undefined
      && await this.isBranchAncestor(record.mergedCommit, record.baseBranch);
  }

  private async isClean(directory: string): Promise<boolean> {
    if (!(await pathExists(directory))) return false;
    return !(await this.git(["status", "--porcelain", "--ignore-submodules=all"], directory)).trim();
  }

  private async ensureWorktreeDirectory(): Promise<void> {
    await fs.mkdir(this.worktreeDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.worktreeDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeUnavailableError("The worktree directory must be a real directory.");
    await fs.chmod(this.worktreeDirectory, 0o700);
  }

  private async listGitWorktrees(): Promise<Array<{ path: string; head: string; branch: string }>> {
    const output = await this.git(["worktree", "list", "--porcelain"]);
    const result: Array<{ path: string; head: string; branch: string }> = [];
    for (const block of output.split(/\n\n+/u)) {
      const lines = block.split("\n");
      const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
      const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      if (worktreePath && head) result.push({ path: path.resolve(worktreePath), head, branch: branchRef?.replace(/^refs\/heads\//u, "") ?? "HEAD" });
    }
    return result;
  }

  private async catalogSessionIds(): Promise<Set<string>> {
    try {
      return new Set((await listSessionCatalog(this.persistenceRoot)).map((item) => item.id));
    } catch (error) {
      // Host 首次启动时 session 目录可能尚未建立；对账应把它视为“没有 catalog”，
      // 不能因为一个空目录把整个 Host 启动打失败。
      if (isNotFound(error)) return new Set();
      throw error;
    }
  }

  private async catalogRecordExists(sessionId: string): Promise<boolean> {
    return (await readSessionCatalogRecord(this.persistenceRoot, sessionId)) !== undefined;
  }

  private async isRepository(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  private async readRecords(): Promise<WorktreeRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.registryPath, "utf8"));
      const records = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && "records" in parsed && Array.isArray(parsed.records)
          ? parsed.records
          : [];
      return records.filter(isWorktreeRecord).map((record) => ({ ...record }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async writeRecords(records: readonly WorktreeRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: registryVersion, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.registryPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async git(args: readonly string[], cwd = this.repoRoot, timeout = 10_000): Promise<string> {
    try {
      const result = await execFileAsync("git", [...args], { cwd, timeout, maxBuffer: 4 * 1024 * 1024 });
      return result.stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (args[0] === "rev-parse" || args[0] === "worktree") throw new WorktreeUnavailableError(`Git worktree operation failed: ${detail}`);
      throw new Error(`Git command failed (${args.join(" ")}): ${detail}`);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(work, work);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isWorktreeRecord(value: unknown): value is WorktreeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === registryVersion
    && typeof record.sessionId === "string"
    && typeof record.worktreePath === "string"
    && typeof record.branch === "string"
    && typeof record.baseBranch === "string"
    && typeof record.baseCommit === "string"
    && typeof record.createdAt === "string"
    && record.status !== undefined
    && ["active", "merged", "conflicted", "orphaned", "kept"].includes(String(record.status))
    && (record.mergeStrategy === undefined || record.mergeStrategy === "merge" || record.mergeStrategy === "squash")
    && (record.mergedCommit === undefined || typeof record.mergedCommit === "string");
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
