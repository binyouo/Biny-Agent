/** macOS Chromium 配置发现和 Cookie 解密；只读取已知应用目录，临时 SQLite 副本用后删除。 */
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredCookie } from "../../../tools/web/cookieJar.js";

const sources = [
  { source: "chrome", appName: "Google Chrome", directory: "Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { source: "chrome-beta", appName: "Google Chrome Beta", directory: "Google/Chrome Beta", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { source: "chrome-canary", appName: "Google Chrome Canary", directory: "Google/Chrome Canary", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { source: "edge", appName: "Microsoft Edge", directory: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge" },
  { source: "brave", appName: "Brave", directory: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
  { source: "chromium", appName: "Chromium", directory: "Chromium", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { source: "arc", appName: "Arc", directory: "Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
  { source: "vivaldi", appName: "Vivaldi", directory: "Vivaldi", keychainService: "Vivaldi Safe Storage", keychainAccount: "Vivaldi" }
] as const;

export interface BrowserProfileRecord {
  id: string;
  source: string;
  appName: string;
  profileName: string;
  userName?: string;
  profilePath: string;
  keychainService: string;
  keychainAccount: string;
}

export async function listBrowserProfiles(base = path.join(os.homedir(), "Library", "Application Support")): Promise<BrowserProfileRecord[]> {
  const profiles: BrowserProfileRecord[] = [];
  for (const source of sources) {
    const root = path.join(base, source.directory);
    let localState: { profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> } } = {};
    try { localState = JSON.parse(await fs.readFile(path.join(root, "Local State"), "utf8")) as typeof localState; }
    catch { continue; }
    const names = new Set<string>(Object.keys(localState.profile?.info_cache ?? {}).filter(validProfileName));
    try { for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory() && validProfileName(entry.name)) names.add(entry.name); }
    catch { continue; }
    for (const name of names) {
      const profilePath = path.join(root, name);
      const realRoot = await fs.realpath(root);
      const realProfile = await fs.realpath(profilePath).catch(() => undefined);
      if (!realProfile || !realProfile.startsWith(`${realRoot}${path.sep}`)) continue;
      if (!await cookieDatabasePath(profilePath)) continue;
      const info = localState.profile?.info_cache?.[name];
      profiles.push({ id: `${source.source}:${name}`, source: source.source, appName: source.appName,
        profileName: info?.name || name, userName: info?.user_name || info?.gaia_name,
        profilePath, keychainService: source.keychainService, keychainAccount: source.keychainAccount });
    }
  }
  return profiles;
}

export async function readBrowserProfileCookies(profile: BrowserProfileRecord, keychainSecret: string): Promise<{ cookies: StoredCookie[]; failed: number }> {
  const source = await cookieDatabasePath(profile.profilePath);
  if (!source) throw new Error("浏览器配置没有 Cookie 数据库。");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "biny-cookie-import-"));
  const copy = path.join(temporary, "Cookies");
  let database: DatabaseSync | undefined;
  try {
    await fs.copyFile(source, copy);
    for (const suffix of ["-wal", "-shm"]) {
      try { await fs.copyFile(`${source}${suffix}`, `${copy}${suffix}`); }
      catch (error) { if (!isNotFound(error)) throw error; }
    }
    database = new DatabaseSync(copy, { readOnly: true });
    // Chromium 的微秒时间戳超过 JS 安全整数；先转为精确文本，再用 BigInt 换算为秒。
    const rows = database.prepare("SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies LIMIT 100000").all() as Array<Record<string, unknown>>;
    const key = pbkdf2Sync(keychainSecret, "saltysalt", 1003, 16, "sha1");
    const cookies: StoredCookie[] = [];
    let failed = 0;
    const now = Date.now() / 1000;
    for (const row of rows) {
      const domain = typeof row.host_key === "string" ? row.host_key : "";
      const name = typeof row.name === "string" ? row.name : "";
      if (!domain || !name || !/^[.]?[a-z\d-]+(?:\.[a-z\d-]+)*$/iu.test(domain)) continue;
      const rawExpiration = typeof row.expires_utc === "string" ? BigInt(row.expires_utc) : 0n;
      // Chromium 的最大整数表示极远的未来；Electron 接受的时间限制在 9999 年末。
      const expirationDate = rawExpiration > 0n
        ? Math.min(Number((rawExpiration - 11_644_473_600_000_000n) / 1_000_000n), 253_402_300_799) : undefined;
      if (expirationDate !== undefined && expirationDate <= now) continue;
      const encrypted = row.encrypted_value instanceof Uint8Array ? Buffer.from(row.encrypted_value) : Buffer.alloc(0);
      const value = encrypted.length ? decryptCookie(encrypted, key, domain) : typeof row.value === "string" ? row.value : undefined;
      if (value === undefined) { failed++; continue; }
      const sameSite = row.samesite === 1 ? "lax" : row.samesite === 2 ? "strict" : row.samesite === 0 ? "no_restriction" : "unspecified";
      cookies.push({ name, value, domain, path: typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/",
        secure: row.is_secure === 1, httpOnly: row.is_httponly === 1, sameSite, expirationDate, hostOnly: !domain.startsWith(".") });
    }
    return { cookies, failed };
  } finally { database?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
}

async function cookieDatabasePath(profilePath: string): Promise<string | undefined> {
  const realProfile = await fs.realpath(profilePath);
  for (const candidate of [path.join(profilePath, "Network", "Cookies"), path.join(profilePath, "Cookies")]) {
    try {
      const realCandidate = await fs.realpath(candidate);
      if (realCandidate.startsWith(`${realProfile}${path.sep}`) && (await fs.stat(realCandidate)).isFile()) return realCandidate;
    }
    catch (error) { if (!isNotFound(error)) throw error; }
  }
  return undefined;
}

function validProfileName(name: string): boolean {
  return name === "Default" || /^Profile \d+$/u.test(name);
}

function decryptCookie(encrypted: Buffer, key: Buffer, domain: string): string | undefined {
  if (!encrypted.subarray(0, 3).equals(Buffer.from("v10")) && !encrypted.subarray(0, 3).equals(Buffer.from("v11"))) return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    let decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    // 新版 Chromium 在明文前加入 host_key 摘要，不能把摘要写入 Electron Cookie。
    if (decrypted.length >= 32) {
      if (decrypted.subarray(0, 32).equals(createHash("sha256").update(domain).digest())) decrypted = decrypted.subarray(32);
    }
    return decrypted.toString("utf8");
  } catch { return undefined; }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
