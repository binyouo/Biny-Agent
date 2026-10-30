/**
 * Agent 情绪的本地 Markdown 存储。
 *
 * 只保存当前 base/context 快照，不维护历史曲线。frontmatter 使用固定的单行字段，trigger
 * 放在正文中，便于人工查看，也保持情绪文件结构稳定。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withGlobalConfigWriteLock } from "../../config/versioned.js";
import { globalConfigDir } from "../../config/paths.js";
import { blendEmotion, DEFAULT_EMOTION_STATE, type BlendedEmotion, type EmotionState } from "./emotionTypes.js";

const baseFileName = "base.md";
const contextDirectoryName = "context";

export interface EmotionStorageOptions {
  configDir?: string;
  now?: () => Date;
}

export class EmotionStorage {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(options: EmotionStorageOptions = {}) {
    this.root = path.join(path.resolve(options.configDir ?? globalConfigDir()), "emotions");
    this.now = options.now ?? (() => new Date());
  }

  get directory(): string {
    return this.root;
  }

  async readBase(): Promise<EmotionState | undefined> {
    return await this.readState(path.join(this.root, baseFileName), DEFAULT_EMOTION_STATE.energy, true);
  }

  async writeBase(state: EmotionState): Promise<void> {
    await withGlobalConfigWriteLock(this.root, async () => await this.writeState(path.join(this.root, baseFileName), state));
  }

  async readContext(sessionId: string): Promise<EmotionState | undefined> {
    return await this.readState(path.join(this.root, contextDirectoryName, `${safeFileName(sessionId)}.md`), DEFAULT_EMOTION_STATE.energy, false);
  }

  async writeContext(sessionId: string, state: EmotionState, signal?: AbortSignal): Promise<void> {
    await this.writeState(
      path.join(this.root, contextDirectoryName, `${safeFileName(sessionId)}.md`),
      state,
      false,
      signal
    );
  }

  async readBlended(sessionId: string | undefined, fatigue: number, now = this.now()): Promise<BlendedEmotion> {
    const base = await this.readBase();
    const context = sessionId === undefined
      ? undefined
      : await this.readState(
        path.join(this.root, contextDirectoryName, `${safeFileName(sessionId)}.md`),
        base?.energy ?? DEFAULT_EMOTION_STATE.energy,
        false
      );
    return blendEmotion(base, context, fatigue, now);
  }

  async listContexts(): Promise<Array<{ sessionId: string; state: EmotionState }>> {
    try {
      const names = await fs.readdir(path.join(this.root, contextDirectoryName));
      const contexts: Array<{ sessionId: string; state: EmotionState }> = [];
      for (const name of names.filter((value) => value.endsWith(".md")).sort()) {
        const state = await this.readState(path.join(this.root, contextDirectoryName, name), DEFAULT_EMOTION_STATE.energy, false);
        if (state) contexts.push({ sessionId: name.slice(0, -3), state });
      }
      return contexts;
    } catch {
      return [];
    }
  }

  private async readState(filePath: string, fallbackEnergy: number, requireEnergy: boolean): Promise<EmotionState | undefined> {
    try {
      return parseEmotionDocument(await fs.readFile(filePath, "utf8"), fallbackEnergy, requireEnergy);
    } catch {
      // 情绪是表达层的可选状态，缺失或损坏都应降级到默认情绪，不阻断主回合。
      return undefined;
    }
  }

  private async writeState(filePath: string, state: EmotionState, includeEnergy = true, signal?: AbortSignal): Promise<void> {
    const document = renderEmotionDocument(state, includeEnergy);
    // Never replace a readable snapshot with a document our own reader rejects.
    if (!parseEmotionDocument(document, DEFAULT_EMOTION_STATE.energy, includeEnergy)) {
      throw new Error("Invalid emotion state: mood must contain 1–32 characters, trigger at most 200 characters, and numeric/time fields must be valid.");
    }
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "w", 0o600);
      await handle.writeFile(document, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Rename admission is the commit boundary; cancellation cannot undo an admitted rename.
      signal?.throwIfAborted();
      await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

function renderEmotionDocument(state: EmotionState, includeEnergy: boolean): string {
  const trigger = state.trigger?.trim();
  const frontmatter = [
    "---",
    `mood: ${state.mood.trim()}`,
    `valence: ${String(state.valence)}`,
    ...(includeEnergy ? [`energy: ${String(state.energy)}`] : []),
    `updated: ${state.updatedAt}`,
    "---"
  ].join("\n");
  return trigger ? `${frontmatter}\n\n${trigger}\n` : `${frontmatter}\n`;
}

function parseEmotionDocument(content: string, fallbackEnergy: number, requireEnergy: boolean): EmotionState | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/u);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]?.split("\n") ?? []) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const key = line.slice(0, separator).trim();
    if (!(key === "mood" || key === "valence" || key === "energy" || key === "updated")) return undefined;
    fields[key] = line.slice(separator + 1).trim();
  }

  const mood = fields.mood;
  const valence = Number(fields.valence);
  const energy = fields.energy === undefined ? fallbackEnergy : Number(fields.energy);
  const updatedAt = fields.updated;
  if (
    !mood
    || Array.from(mood).length > 32
    || !Number.isFinite(valence)
    || (requireEnergy && fields.energy === undefined)
    || !Number.isFinite(energy)
    || valence < 0
    || valence > 10
    || energy < 0
    || energy > 10
    || !updatedAt
    || !Number.isFinite(Date.parse(updatedAt))
  ) return undefined;

  const trigger = match[2]?.trim() || undefined;
  if (trigger !== undefined && Array.from(trigger).length > 200) return undefined;
  return { mood, valence, energy, updatedAt, trigger };
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 180);
  return safe || randomUUID();
}
