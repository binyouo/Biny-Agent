/** 跨进程疲劳与主动睡眠状态；时间计算统一在运行时，命令只改变真实持久状态。 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { globalAgentDir } from "../../config/paths.js";
import { withGlobalConfigWriteLock } from "../../config/versioned.js";

const twoHoursMs = 2 * 60 * 60 * 1_000;
export type FatigueLevel = "awake" | "tired" | "sleepy" | "sleeping";
export type FatigueAction = "sleep" | "wake" | "rest";
export interface FatigueState {
  fatigue: number;
  messageCount: number;
  lastMessageTime: string;
  lastRestTime: string;
  manualSleep: boolean;
  manualWake: boolean;
}
export interface FatigueStatus {
  fatigue: number;
  level: FatigueLevel;
  messageCount: number;
  isNight: boolean;
  manualSleep: boolean;
  manualWake: boolean;
  lastRestTime: string;
}
export interface FatigueServiceOptions { agentDir?: string; now?: () => Date; }

export class FatigueService {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: FatigueState;
  constructor(options: FatigueServiceOptions = {}) {
    this.filePath = path.join(path.resolve(options.agentDir ?? globalAgentDir()), "fatigue.json");
    this.now = options.now ?? (() => new Date());
    this.state = defaultState(this.now());
  }
  get path(): string { return this.filePath; }
  async initialize(): Promise<void> { await this.read(); }
  async read(): Promise<FatigueState> {
    return await withGlobalConfigWriteLock(path.dirname(this.filePath), async () => {
      const state = await this.readState();
      const before = JSON.stringify(state);
      this.refreshSleep(state, this.now());
      if (before !== JSON.stringify(state)) await this.writeState(state);
      this.state = state;
      return { ...state };
    });
  }
  async recordMessage(): Promise<FatigueStatus> {
    return await this.mutate((state) => {
      state.fatigue = Math.min(100, state.fatigue + 1.5);
      state.messageCount += 1;
    });
  }
  async change(action: FatigueAction): Promise<FatigueStatus> {
    return await this.mutate(async (state, now) => {
      state.lastRestTime = now.toISOString();
      state.manualSleep = action === "sleep";
      state.manualWake = action === "wake";
      if (action === "wake") state.fatigue = Math.max(0, state.fatigue - 30);
      if (action === "rest") { state.fatigue = 0; state.messageCount = 0; }
    });
  }
  status(): FatigueStatus {
    const now = this.now();
    const fatigue = Math.round(Math.min(100, decayFatigue(this.state, now) + fatigueTimeBonus(now)));
    const manualWake = this.state.manualWake && now.getTime() - Date.parse(this.state.lastRestTime) < twoHoursMs;
    const hour = now.getHours();
    return {
      fatigue,
      level: this.state.manualSleep ? "sleeping" : manualWake && !(hour >= 1 && hour < 6) ? "awake" : fatigueLevel(fatigue),
      messageCount: this.state.messageCount,
      isNight: hour >= 23 || hour < 8,
      manualSleep: this.state.manualSleep, manualWake, lastRestTime: this.state.lastRestTime
    };
  }
  getFatigue(): number { return this.status().fatigue; }
  async currentStatus(): Promise<FatigueStatus> { await this.read(); return this.status(); }
  private async mutate(change: (state: FatigueState, now: Date) => void | Promise<void>): Promise<FatigueStatus> {
    return await withGlobalConfigWriteLock(path.dirname(this.filePath), async () => {
      const state = await this.readState();
      const now = this.now();
      this.refreshSleep(state, now);
      state.fatigue = decayFatigue(state, now);
      state.lastMessageTime = now.toISOString();
      await change(state, now);
      await this.writeState(state);
      this.state = state;
      return this.status();
    });
  }
  private refreshSleep(state: FatigueState, now: Date): boolean {
    const rested = now.getTime() - Date.parse(state.lastRestTime) >= twoHoursMs;
    if (state.manualWake && rested) state.manualWake = false;
    if (state.manualSleep && rested && now.getHours() >= 8 && now.getHours() < 22) {
      state.manualSleep = false;
      state.fatigue = Math.max(0, decayFatigue(state, now) - 40);
      state.lastMessageTime = now.toISOString();
      state.lastRestTime = now.toISOString();
      return true;
    }
    return false;
  }
  private async readState(): Promise<FatigueState> {
    let content: string;
    try { content = await fs.readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState(this.now());
      throw error;
    }
    try {
      const value = JSON.parse(content) as Partial<FatigueState>;
      const lastMessageTime = typeof value.lastMessageTime === "number" ? new Date(value.lastMessageTime).toISOString() : value.lastMessageTime;
      if (!Number.isFinite(value.fatigue) || value.fatigue! < 0 || value.fatigue! > 100
        || !Number.isSafeInteger(value.messageCount) || value.messageCount! < 0
        || !lastMessageTime || !Number.isFinite(Date.parse(lastMessageTime))) return defaultState(this.now());
      return {
        fatigue: value.fatigue!, messageCount: value.messageCount!, lastMessageTime,
        lastRestTime: value.lastRestTime && Number.isFinite(Date.parse(value.lastRestTime)) ? value.lastRestTime : lastMessageTime,
        manualSleep: value.manualSleep === true, manualWake: value.manualWake === true
      };
    } catch { return defaultState(this.now()); }
  }
  private async writeState(state: FatigueState): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
}
export function fatigueLevel(value: number): FatigueLevel {
  return value >= 75 ? "sleeping" : value >= 50 ? "sleepy" : value >= 30 ? "tired" : "awake";
}
export function fatigueTimeBonus(date: Date): number {
  const hour = date.getHours();
  if (hour >= 1 && hour < 6) return 30;
  if (hour >= 23 || hour < 8) return 15;
  return hour >= 13 && hour <= 14 ? 8 : 0;
}
function decayFatigue(state: FatigueState, now: Date): number {
  return Math.max(0, state.fatigue - Math.max(0, now.getTime() - Date.parse(state.lastMessageTime)) / 60_000 * 0.8);
}
function defaultState(now: Date): FatigueState {
  return { fatigue: 0, messageCount: 0, lastMessageTime: now.toISOString(), lastRestTime: now.toISOString(), manualSleep: false, manualWake: false };
}
