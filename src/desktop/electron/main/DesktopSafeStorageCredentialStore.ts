/**
 * 桌面端模型凭据存储：用 Electron `safeStorage` 加密后落盘到一个 biny 自管文件。
 *
 * 为什么不沿用 CLI 的 `security` 子进程：`security` 以命令行身份写 Keychain，创建的条目
 * 访问控制（ACL）不会绑定到 Biny 的应用签名身份，于是每次写入都要重新授权；而 CLI 模式
 * 下系统授权框常常不弹出，进程就那么阻塞到超时——这正是设置保存卡死的根因。
 *
 * `safeStorage` 走系统 Keychain Services 派生加密密钥，能正常弹授权且授权一次记住；
 * 凭据本体加密后存在我们自己的文件里，后续读写只是本地文件 + 一次进程内解密，不再碰
 * `security`，也不会再有 ACL 卡死。
 *
 * `electron` 通过惰性 import 引入：这个模块可能被 Node（测试/构建）加载，顶层静态 import
 * electron 会在非 Electron 环境直接抛错。加解密函数在首次实际使用时才解析。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CredentialStore } from "../../../config/credentials.js";
import { assertTestStatePathIsolated } from "../../../config/paths.js";

const CREDENTIALS_FILE = "credentials.enc";

/** 抽象加解密，便于测试注入内存实现；生产默认走 Electron safeStorage。 */
export interface SafeStorageCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(payload: Buffer): string;
}

async function defaultCipher(): Promise<SafeStorageCipher> {
  const { safeStorage } = await import("electron");
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (payload) => safeStorage.decryptString(payload)
  };
}

export class DesktopSafeStorageCredentialStore implements CredentialStore {
  readonly persistent = true;
  private readonly filePath: string;
  /** 同步其它 Electron 进程的轮换/撤销；同一文件版本内只解密一次。 */
  private cache: Record<string, string> | undefined;
  private cacheRevision: string | undefined;
  private writeTail = Promise.resolve();

  constructor(
    root: string,
    private readonly cipherSource: () => Promise<SafeStorageCipher> | SafeStorageCipher = defaultCipher
  ) {
    assertTestStatePathIsolated(root);
    this.filePath = path.join(root, CREDENTIALS_FILE);
  }

  async get(account: string): Promise<string | undefined> {
    const all = await this.readAll();
    const value = all[account];
    return value === undefined || value === "" ? undefined : value;
  }

  async set(account: string, value: string): Promise<void> {
    await this.mutate((all) => {
      all[account] = value;
    });
  }

  async delete(account: string): Promise<void> {
    await this.mutate((all) => {
      delete all[account];
    });
  }

  private async mutate(change: (all: Record<string, string>) => void): Promise<void> {
    const run = this.writeTail.then(async () => {
      const all = await this.readAll();
      change(all);
      await this.writeAll(all);
    });
    this.writeTail = run.then(() => undefined, () => undefined);
    await run;
  }

  private async cipher(): Promise<SafeStorageCipher> {
    return await this.cipherSource();
  }

  private async readAll(): Promise<Record<string, string>> {
    const revision = await this.readFileRevision();
    if (this.cache !== undefined && this.cacheRevision === revision) return { ...this.cache };
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cache = {};
      this.cacheRevision = "missing";
      return {};
    }
    // Only an actual ENOENT read skips Keychain. A file created after stat must
    // still pass the same security check; other filesystem errors propagate.
    const cipher = await this.cipher();
    if (!cipher.isAvailable()) {
      throw new Error("系统加密存储不可用，无法读取模型凭据。");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      this.cache = {};
      this.cacheRevision = revision;
      return {};
    }
    let parsed: Record<string, string>;
    try {
      const decrypted = cipher.decrypt(Buffer.from(trimmed, "base64"));
      const value = JSON.parse(decrypted) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("凭据文件格式无效。");
      }
      parsed = value as Record<string, string>;
    } catch (error) {
      throw new Error(`模型凭据解密失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.cache = parsed;
    this.cacheRevision = revision;
    return { ...parsed };
  }

  private async writeAll(all: Record<string, string>): Promise<void> {
    const cipher = await this.cipher();
    if (!cipher.isAvailable()) {
      throw new Error("系统加密存储不可用，无法保存模型凭据。");
    }
    const encrypted = cipher.encrypt(JSON.stringify(all));
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, encrypted.toString("base64"), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.filePath);
    this.cache = undefined;
    this.cacheRevision = undefined;
  }

  private async readFileRevision(): Promise<string> {
    try {
      const stat = await fs.stat(this.filePath, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return "missing";
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
