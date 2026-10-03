/**
 * 工作区快照模块。
 *
 * agent 改坏了要能退回去。难点是"退回去"不能变成第二次破坏，所以这里有两条硬约束：
 *
 * - **建快照不碰用户的 git 状态**。用独立的临时索引文件加 `commit-tree`，快照挂在
 *   `refs/biny/checkpoints/*` 上。用户的暂存区、HEAD、分支历史、reflog 全都不受影响，
 *   `git log` 里也看不见这些提交。
 * - **恢复不删文件**。快照之后新建的文件会被移到 `.biny/undo-trash/<时间戳>/` 而不是
 *   删除。恢复本身也是可逆的 —— 一个"撤销"功能如果会让人丢东西，就没人敢用。
 *
 * 快照覆盖已跟踪文件和未被 .gitignore 排除的新文件。已跟踪文件后来被忽略仍属于
 * 快照范围；从未跟踪且被忽略的本地文件不在其中，恢复时也不会动它们。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentDir, ensureAgentDirs } from "./store.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";

const run = promisify(execFile);
const checkpointRefPrefix = "refs/biny/checkpoints";
/**
 * agent 自己的状态目录必须整个排除在快照之外。它进了快照，恢复就会覆盖会话日志、计划清单，
 * 乃至记录着"要恢复到哪个快照"的索引文件本身 —— 撤销会把自己的依据一起抹掉。
 */
const agentStatePaths = [".biny", ".agent"];
const maxCheckpoints = 50;

export interface Checkpoint {
  id: string;
  label: string;
  commit: string;
  createdAt: string;
}

export interface RestoreSummary {
  checkpoint: Checkpoint;
  restoredFiles: number;
  /** 快照之后新建、这次被移走的文件（工作区相对路径）。 */
  movedAside: string[];
  /** 移走的文件放在哪里；没有移动时为 undefined。 */
  trashDirectory?: string;
}

export class CheckpointStore {
  private readonly workspaceRoot: string;
  private readonly gitDir: string;

  private constructor(workspaceRoot: string, gitDir: string) {
    this.workspaceRoot = workspaceRoot;
    this.gitDir = gitDir;
  }

  /** 不是 git 仓库时返回 undefined —— 快照能力就是不可用，不去伪造一个。 */
  static async open(workspaceRoot: string): Promise<CheckpointStore | undefined> {
    try {
      const { stdout } = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: workspaceRoot });
      return new CheckpointStore(path.resolve(workspaceRoot), stdout.trim());
    } catch {
      return undefined;
    }
  }

  async create(label: string): Promise<Checkpoint> {
    // pid+毫秒在并发下同毫秒会撞名，加随机成分保证临时索引互不污染。
    // 放在 Git 目录内，使 split-index 相对引用的 sharedindex 仍能被副本找到。
    const temporaryIndex = path.join(this.gitDir, `biny-checkpoint-index-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`);
    const temporaryPaths = `${temporaryIndex}.paths`;
    try {
      // 从真实 index 复制文件集合，再在副本上更新工作区内容。空 index 会漏掉
      // 已跟踪但后来命中 .gitignore 的路径，使恢复误把它们当成新增文件。
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      const indexPath = (await this.git(["rev-parse", "--git-path", "index"])).trim();
      try {
        await fs.copyFile(path.resolve(this.workspaceRoot, indexPath), temporaryIndex);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await this.git(["read-tree", "--empty"], env);
      }
      const files = await this.trackedFilesNow(env);
      const statePaths = await this.excludedStatePaths([...files]);
      // --sparse 也清除稀疏范围外的状态；只改 index 副本，不改变用户暂存区。
      await this.git(["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--sparse", "--", ...statePaths], env);
      const skipped = new Set((await this.gitPaths(["ls-files", "-t", "-z", "--", "."], env))
        .filter((entry) => entry.startsWith("S ")).map((entry) => entry.slice(2)));
      const updatedFiles: string[] = [];
      for (const file of withoutStateFiles([...files], statePaths)) {
        if (skipped.has(file)) {
          try {
            await fs.lstat(path.join(this.workspaceRoot, file));
          } catch (error) {
            // 缺失的 skip-worktree 文件是稀疏投影，不是用户删除；保留复制的缓存条目。
            if (isMissingFile(error)) continue;
            throw error;
          }
        }
        updatedFiles.push(file);
      }
      if (updatedFiles.length) {
        // 显式清单避免 ignored 目录的排除 pathspec 报错；文件名按 NUL 分隔且不解释为 pathspec。
        await fs.writeFile(temporaryPaths, `${updatedFiles.join("\0")}\0`, { mode: 0o600 });
        await this.git(["--literal-pathspecs", "add", "-A", "--sparse", `--pathspec-from-file=${temporaryPaths}`, "--pathspec-file-nul"], env);
      }
      const tree = (await this.git(["write-tree"], env)).trim();
      const commit = (await this.git([
        "commit-tree", tree,
        "-m", `biny checkpoint: ${label}`
      ], {
        ...env,
        GIT_AUTHOR_NAME: "Biny", GIT_AUTHOR_EMAIL: "checkpoint@biny.local",
        GIT_COMMITTER_NAME: "Biny", GIT_COMMITTER_EMAIL: "checkpoint@biny.local"
      })).trim();
      const checkpoint: Checkpoint = { id: shortId(commit), label, commit, createdAt: new Date().toISOString() };
      // ref 让快照提交不会被 gc 掉，同时留在 refs/biny 下不污染 refs/heads。
      await this.git(["update-ref", `${checkpointRefPrefix}/${checkpoint.id}`, commit]);
      await this.appendIndexEntry(checkpoint);
      return checkpoint;
    } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(temporaryPaths, { force: true });
    }
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.indexPath(), "utf8"));
      const entries = (parsed as { checkpoints?: unknown }).checkpoints;
      return Array.isArray(entries) ? entries.filter(isCheckpoint) : [];
    } catch {
      return [];
    }
  }

  async restore(id: string): Promise<RestoreSummary> {
    const checkpoints = await this.list();
    const checkpoint = checkpoints.find((entry) => entry.id === id)
      ?? (id === "latest" ? checkpoints[checkpoints.length - 1] : undefined);
    if (!checkpoint) throw new Error(`No such checkpoint: ${id}`);

    const snapshot = await this.filesInCommit(checkpoint.commit);
    const current = await this.trackedFilesNow();
    const statePaths = await this.excludedStatePaths([...snapshot, ...current]);
    const snapshotFiles = new Set(withoutStateFiles(snapshot, statePaths));
    const currentFiles = new Set(withoutStateFiles([...current], statePaths));
    const addedSinceCheckpoint = [...currentFiles].filter((file) => !snapshotFiles.has(file)).sort();

    // 先把新增文件挪走，再落回快照内容。顺序反过来的话，新增文件会被后面的写入覆盖判断漏掉。
    let trashDirectory: string | undefined;
    const movedAside: string[] = [];
    if (addedSinceCheckpoint.length) {
      trashDirectory = path.join(".biny", "undo-trash", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
      await ensureAgentDirs(this.workspaceRoot);
      for (const file of addedSinceCheckpoint) {
        const destination = path.join(this.workspaceRoot, trashDirectory, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try {
          await fs.rename(path.join(this.workspaceRoot, file), destination);
          movedAside.push(file);
        } catch (error) {
          // Git index 仍可列出工作区已经消失的暂存文件；它没有东西可移。
          if (isMissingFile(error)) continue;
          throw new Error(`Cannot move ${file} to undo trash at ${trashDirectory}`, { cause: error });
        }
      }
    }

    // 用临时索引把快照内容写回工作区。`git checkout <commit> -- .` 会顺带改写用户的暂存区，
    // 而 `checkout-index` 只认给它的索引文件，用户暂存了什么完全不受影响。
    const restoreIndex = path.join(os.tmpdir(), `biny-restore-index-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: restoreIndex };
      await this.git(["read-tree", checkpoint.commit], env);
      await this.git(["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--sparse", "--", ...statePaths], env);
      await this.git(["checkout-index", "-a", "-f"], env);
    } finally {
      await fs.rm(restoreIndex, { force: true });
    }

    return {
      checkpoint,
      restoredFiles: snapshotFiles.size,
      movedAside,
      trashDirectory: movedAside.length ? trashDirectory : undefined
    };
  }

  private async filesInCommit(commit: string): Promise<string[]> {
    return await this.gitPaths(["ls-tree", "-r", "-z", "--name-only", commit]);
  }

  private async trackedFilesNow(env?: NodeJS.ProcessEnv): Promise<Set<string>> {
    // -c 已跟踪 + -o 未跟踪，--exclude-standard 让 .gitignore 生效，和建快照时的范围一致。
    return new Set(await this.gitPaths(["ls-files", "-co", "-z", "--exclude-standard", "--", "."], env));
  }

  private async excludedStatePaths(files: readonly string[]): Promise<string[]> {
    const excluded = new Set(agentStatePaths);
    let caseInsensitive: boolean | undefined;
    for (const directory of new Set(files.map((file) => file.split("/")[0] ?? ""))) {
      const canonical = agentStatePaths.find((state) => state !== directory && state.toLowerCase() === directory.toLowerCase());
      if (!canonical) continue;
      const [state, alias] = await Promise.all([canonical, directory].map(async (name) => {
        try {
          // 比较目录项本身，不跟随普通用户符号链接的目标。
          return await fs.lstat(path.join(this.workspaceRoot, name), { bigint: true });
        } catch (error) {
          if (isMissingFile(error)) return undefined;
          throw error;
        }
      }));
      if (state && alias && state.dev === alias.dev && state.ino === alias.ino
        || !state && !alias && (caseInsensitive ??= await this.caseInsensitiveRoot())) {
        excluded.add(directory);
      }
    }
    return [...excluded];
  }

  private async caseInsensitiveRoot(): Promise<boolean> {
    // 稀疏投影中两个拼写都可能缺失；空目录探针核实当前根目录的实际 lookup 规则。
    // 空目录不会进入 Git 文件清单，不用 core.ignorecase 猜测文件系统行为。
    const probe = await fs.mkdtemp(path.join(this.workspaceRoot, ".biny-checkpoint-case-"));
    try {
      const original = await fs.stat(probe, { bigint: true });
      try {
        const alias = await fs.stat(path.join(path.dirname(probe), path.basename(probe).toUpperCase()), { bigint: true });
        return original.dev === alias.dev && original.ino === alias.ino;
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
    } finally {
      await fs.rmdir(probe);
    }
  }

  private async gitPaths(args: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
    // -z 禁止 Git 对非 ASCII、换行和边界空格做引用/转义；文件名不可 trim。
    const { stdout } = await run("git", args, { cwd: this.workspaceRoot, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return stdout.toString("utf8").split("\0").filter(Boolean);
  }

  private indexPath(): string {
    return path.join(agentDir(this.workspaceRoot), "checkpoints.json");
  }

  private async appendIndexEntry(checkpoint: Checkpoint): Promise<void> {
    await ensureAgentDirs(this.workspaceRoot);
    // 会话各自拥有 coordinator，索引却按工作区共享；锁必须覆盖完整读改写并跨进程。
    await withLocalFileWriteLock(agentDir(this.workspaceRoot), "checkpoints.json.lock", async () => {
      // 查询可以容错，发布不能把读失败当空索引，否则会覆盖已有撤销入口。
      const checkpoints = [...await this.readIndex(), checkpoint];
      const dropped = checkpoints.slice(0, Math.max(0, checkpoints.length - maxCheckpoints));
      const retained = checkpoints.slice(-maxCheckpoints);
      const target = this.indexPath();
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, checkpoints: retained })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      // 过期的快照连 ref 一起删掉，否则那些提交会永远留在仓库里。
      for (const entry of dropped) {
        await this.git(["update-ref", "-d", `${checkpointRefPrefix}/${entry.id}`]).catch(() => undefined);
      }
    });
  }

  private async readIndex(): Promise<Checkpoint[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath(), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { checkpoints?: unknown }).checkpoints)) {
      throw new Error("Invalid checkpoint index.");
    }
    const entries = (parsed as { checkpoints: unknown[] }).checkpoints;
    if (!entries.every(isCheckpoint)) throw new Error("Invalid checkpoint index entry.");
    return entries;
  }

  private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await run("git", args, {
      cwd: this.workspaceRoot,
      env: env ?? process.env,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  }
}

function withoutStateFiles(files: readonly string[], directories: readonly string[]): string[] {
  return files.filter((file) => !directories.some((directory) => file === directory || file.startsWith(`${directory}/`)));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function shortId(commit: string): string {
  return commit.slice(0, 12);
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Checkpoint>;
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.commit === "string"
    && typeof candidate.createdAt === "string";
}
