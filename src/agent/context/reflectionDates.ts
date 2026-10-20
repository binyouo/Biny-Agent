import { promises as fs } from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";
import { withGlobalConfigWriteLock } from "../../config/versioned.js";

const markerName = ".reflection-dates";

export function reflectionDiaryPath(dateKey: string, configDir = globalConfigDir()): string {
  assertDateKey(dateKey);
  return path.join(path.resolve(configDir), "diary", `${dateKey}.md`);
}

export async function readReflectionDiary(dateKey: string, configDir = globalConfigDir()): Promise<string | undefined> {
  try {
    return await fs.readFile(reflectionDiaryPath(dateKey, configDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function hasReflectionDate(dateKey: string, configDir = globalConfigDir()): Promise<boolean> {
  return (await readReflectionDates(configDir)).has(dateKey);
}

export async function markReflectionDate(dateKey: string, configDir = globalConfigDir()): Promise<void> {
  assertDateKey(dateKey);
  const root = path.resolve(configDir);
  await withGlobalConfigWriteLock(root, async () => {
    const dates = await readReflectionDates(root);
    if (dates.has(dateKey)) return;
    dates.add(dateKey);
    const target = path.join(root, markerName);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${[...dates].sort().join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
}

function assertDateKey(dateKey: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey) || Number.isNaN(Date.parse(dateKey))
    || new Date(dateKey).toISOString().slice(0, 10) !== dateKey) throw new Error("Invalid reflection date.");
}

async function readReflectionDates(configDir: string): Promise<Set<string>> {
  try {
    return new Set((await fs.readFile(path.join(configDir, markerName), "utf8")).split(/\s+/u).filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}
