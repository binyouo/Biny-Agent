/**
 * 可演化 Soul 的全局 Markdown 存储。
 *
 * SOUL.md 是隐藏配置目录中的用户覆盖文件；文件不存在时只使用固定 system prompt 中的
 * 默认人格，不生成内置 Soul 正文。写入采用临时文件替换和目录锁，避免文件写成半截内容。
 */
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { migrateLegacyGlobalState } from "../../config/globalStateMigration.js";
import { globalConfigDir } from "../../config/paths.js";
import { renderSoulPrompt, type SoulPromptSource } from "../builtinSoul.js";

const soulFileName = "SOUL.md";
const lockDirectoryName = ".soul.lock";
const lockTimeoutMs = 5_000;
const staleLockMs = 120_000;
export const maxSoulChars = 32_000;
export const maxSoulTraitChars = 500;
export const maxSoulTraits = 15;

export interface SoulStorageOptions {
  configDir?: string;
  now?: () => Date;
}

export interface SoulSnapshot {
  content: string;
  source: SoulPromptSource;
  revision: string;
  path: string;
}

export class SoulStorage {
  private readonly now: () => Date;
  private readonly root: string;
  private readonly filePath: string;
  private readonly migrateDefaultState: boolean;

  constructor(options: SoulStorageOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.migrateDefaultState = options.configDir === undefined;
    this.root = path.resolve(options.configDir ?? globalConfigDir());
    this.filePath = path.join(this.root, soulFileName);
  }

  get directory(): string {
    return this.root;
  }

  get path(): string {
    return this.filePath;
  }

  async initialize(): Promise<void> {
    await this.migrateIfDefault();
    await this.ensureRoot();
  }

  async read(): Promise<SoulSnapshot> {
    await this.migrateIfDefault();
    const userContent = normalizeSoulContent(await readOptional(this.filePath));
    return {
      content: userContent,
      revision: createHash("sha256").update(userContent).digest("hex"),
      source: userContent ? "user" : "builtin",
      path: this.filePath
    };
  }

  async promptText(): Promise<string | undefined> {
    const snapshot = await this.read();
    return snapshot.source === "user" ? renderSoulPrompt(snapshot.content, snapshot.source, snapshot.path) : undefined;
  }

  async set(content: string): Promise<SoulSnapshot> {
    await this.migrateIfDefault();
    const normalized = validateSoulContent(content);
    return await this.withLock(async () => {
      await this.writeFile(this.filePath, normalized + "\n");
      return await this.read();
    });
  }

  /** 为外部编辑器准备用户覆盖文件；默认人格不复制进用户文件。 */
  async ensureEditable(): Promise<SoulSnapshot> {
    await this.migrateIfDefault();
    return await this.withLock(async () => {
      const current = normalizeSoulContent(await readOptional(this.filePath));
      if (!current) await this.writeFile(this.filePath, "# Soul\n\n");
      return await this.read();
    });
  }

  async reset(): Promise<SoulSnapshot> {
    await this.migrateIfDefault();
    return await this.withLock(async () => {
      await fs.unlink(this.filePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      return await this.read();
    });
  }

  async appendTrait(description: string): Promise<SoulSnapshot> {
    await this.migrateIfDefault();
    return await this.withLock(async () => {
      const current = normalizeSoulContent(await readOptional(this.filePath));
      const next = appendTrait(current, description, this.now());
      if (next !== current) await this.writeFile(this.filePath, validateSoulContent(next) + "\n");
      return await this.read();
    });
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
  }

  private async migrateIfDefault(): Promise<void> {
    if (this.migrateDefaultState) await migrateLegacyGlobalState();
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    const lockPath = path.join(this.root, lockDirectoryName);
    const startedAt = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) await fs.rm(lockPath, { recursive: true, force: true });
        } catch (statError) {
          if (!isNotFound(statError)) throw statError;
        }
        if (Date.now() - startedAt >= lockTimeoutMs) throw new Error("Soul 存储锁等待超时，请稍后重试。");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + "." + randomUUID() + ".tmp";
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function validateSoulContent(content: string): string {
  const normalized = normalizeSoulContent(content);
  if (!normalized) throw new Error("Soul content cannot be empty.");
  if (normalized.length > maxSoulChars) {
    throw new Error("Soul content cannot exceed " + String(maxSoulChars) + " characters.");
  }
  return normalized;
}

function normalizeSoulContent(content: string | undefined): string {
  return content?.replace(/\r\n?/gu, "\n").trim() ?? "";
}

function normalizeTrait(description: string): string {
  return description
    .replace(/\r\n?/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^-+\s*/u, "")
    .trim();
}

/** 成长区保留日期和最多十五条特质，其他章节保持原样。 */
function appendTrait(content: string, description: string, now: Date): string {
  const trait = validateTrait(description);
  const lines = content.split("\n");
  let start = lines.findIndex(line => line.trim().toLowerCase() === "## evolved traits");
  if (start < 0) { lines.push("", "## Evolved Traits", ""); start = lines.length - 2; }
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/u.test(lines[end]!)) end += 1;
  const section = lines.slice(start + 1, end).filter(line => !/^<!-- biny-soul-growth:\d{4}-\d{2}-\d{2} -->$/u.test(line.trim()));
  if (!section.some(line => traitDescription(line) === trait)) {
    while (section.filter(line => traitDescription(line) !== undefined).length >= maxSoulTraits) {
      section.splice(section.findIndex(line => traitDescription(line) !== undefined), 1);
    }
    let insertion = section.length;
    while (insertion > 0 && section[insertion - 1]?.trim() === "") insertion -= 1;
    section.splice(insertion, 0, `- [${now.toISOString().slice(0, 10)}] ${trait}`);
  }
  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n").trim();
}

function traitDescription(line: string): string | undefined {
  return line.match(/^\s*-\s+(?:\[\d{4}-\d{2}-\d{2}\]\s+)?(.+)$/u)?.[1];
}

function validateTrait(description: string): string {
  const trait = normalizeTrait(description);
  if (!trait) throw new Error("Soul trait cannot be empty.");
  if (trait.length > maxSoulTraitChars) throw new Error("Soul trait cannot exceed " + String(maxSoulTraitChars) + " characters.");
  return trait;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
