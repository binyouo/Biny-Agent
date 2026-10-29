import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

let loadedKey: { path: string; value: Buffer } | undefined;

function readKey(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== 32) throw new Error("Privacy placeholder key is invalid; the saved key was not changed.");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** 密钥先完整写入私有临时文件，再独占发布；并发进程只采用发布成功的同一份密钥。 */
function placeholderKey(): Buffer {
  const root = globalConfigDir(), file = path.join(root, "redact.key");
  if (loadedKey?.path === file) return loadedKey.value;
  let value: Buffer;
  try { value = readKey(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(path.join(root, ".redact-key-"));
    try {
      const candidate = path.join(temporary, "key");
      writeFileSync(candidate, randomBytes(32), { mode: 0o600, flag: "wx" });
      try { linkSync(candidate, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      value = readKey(file);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  loadedKey = { path: file, value };
  return value;
}

function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f];
  return out;
}

/**
 * 一个值的占位符，可重复计算而不登记原值。
 * 供「预览」和「发送时才发现要再次遮蔽的已知值」使用。
 */
export function placeholderTag(kind: string, value: string, scope = ""): string {
  const digest = createHmac("sha256", placeholderKey()).update(scope).update("\0").update(kind).update("\0").update(value).digest();
  return `{{${kind}_${base32(digest).slice(0, 8).toLowerCase()}}}`;
}

/** 与 placeholderTag 同形的占位符正文本，用于识别已经存在的占位符。 */
export const placeholderPattern = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g;
