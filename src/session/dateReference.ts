/** 本机日期引用：把明确范围编码进消息，并用本地密钥拒绝被改写的引用。 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalAgentDir } from "../config/paths.js";

export interface DateReferenceRange {
  startDate: string;
  endDate: string;
  timeZone: string;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const referencePattern = /^@\[([^\]\n]{1,80})\]\(biny:\/\/date\/([A-Za-z0-9_-]+)\.([a-f0-9]{64})\)$/u;

function validDay(day: string): boolean {
  if (!dayPattern.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function validateDateReferenceRange(range: DateReferenceRange): DateReferenceRange {
  if (!validDay(range.startDate) || !validDay(range.endDate)) throw new Error("Invalid date reference day.");
  const duration = (Date.parse(`${range.endDate}T00:00:00.000Z`) - Date.parse(`${range.startDate}T00:00:00.000Z`)) / 86_400_000;
  if (duration < 1 || duration > 366) throw new Error("Invalid date reference range.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: range.timeZone });
  } catch { throw new Error("Invalid date reference time zone."); }
  return range;
}

function key(root: string, create: boolean): Buffer {
  const file = path.join(root, "date-reference.key");
  if (create) {
    mkdirSync(root, { recursive: true });
    try { writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!lstatSync(file).isFile()) throw new Error("Invalid date reference key.");
  const bytes = readFileSync(file);
  if (bytes.length !== 32) throw new Error("Invalid date reference key.");
  return bytes;
}

/** 索引版本包含密钥指纹；密钥被删除或轮换后旧引用投影必须重算。 */
export function dateReferenceKeyFingerprint(root = globalAgentDir()): string {
  try { return createHash("sha256").update(key(root, false)).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

/** endDate 为不包含的结束日，与 timeline 查询保持一致。 */
export function createDateReference(range: DateReferenceRange, label = range.startDate, root = globalAgentDir()): string {
  validateDateReferenceRange(range);
  if (!label.trim() || label.length > 80 || /[\]\n]/u.test(label)) throw new Error("Invalid date reference label.");
  const payload = Buffer.from(JSON.stringify([range.startDate, range.endDate, range.timeZone]), "utf8").toString("base64url");
  const signature = createHmac("sha256", key(root, true)).update(`${label}\0${payload}`).digest("hex");
  return `@[${label}](biny://date/${payload}.${signature})`;
}

export function parseDateReference(reference: string, root = globalAgentDir()): { label: string; range: DateReferenceRange } | undefined {
  if (!reference.includes("biny://date/")) return undefined;
  const match = reference.match(referencePattern);
  if (!match) throw new Error("Invalid date reference.");
  let expected: Buffer;
  try { expected = createHmac("sha256", key(root, false)).update(`${match[1]!}\0${match[2]!}`).digest(); }
  catch { throw new Error("Invalid date reference signature."); }
  const actual = Buffer.from(match[3]!, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid date reference signature.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid date reference payload."); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((value) => typeof value === "string")) {
    throw new Error("Invalid date reference payload.");
  }
  const values = parsed as [string, string, string];
  const range = validateDateReferenceRange({ startDate: values[0], endDate: values[1], timeZone: values[2] });
  return { label: match[1]!, range };
}
