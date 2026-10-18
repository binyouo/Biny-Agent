import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../../config/paths.js";
import { withGlobalConfigWriteLock } from "../../config/versioned.js";

const eventSchema = z.object({ day: z.number().int().positive(), summary: z.string(), cost: z.number().nonnegative(), timestamp: z.string().datetime() });
const tripSchema = z.object({ destination: z.string(), departedAt: z.string().datetime(), day: z.number().int().positive(),
  events: z.array(eventSchema), mood: z.string(), budget: z.number().nonnegative() });
const stateSchema = z.object({ current: tripSchema.optional(), trips: z.array(tripSchema.extend({ returnedAt: z.string().datetime(), days: z.number().int().positive(), totalSpent: z.number().nonnegative() })) });
export type TravelState = z.infer<typeof stateSchema>;

/** 当前行程与历史在同一事务中保存，回家后不能留下重复或丢失的行程。 */
export class TravelStorage {
  readonly directory: string;
  constructor(configDir = globalConfigDir(), private readonly now = () => new Date(), private readonly random = Math.random) {
    this.directory = path.join(configDir, "travels");
  }
  async read(): Promise<TravelState> {
    try { return stateSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, "state.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { trips: [] };
      throw error;
    }
  }
  async change(action: "go" | "event" | "advance" | "mood" | "home", text?: string): Promise<TravelState> {
    if (["go", "event", "mood"].includes(action) && (!text?.trim() || text.length > 2000)) throw new Error("Provide 1–2000 characters.");
    return await withGlobalConfigWriteLock(this.directory, async () => {
      const state = await this.read();
      const timestamp = this.now().toISOString();
      if (action === "go") {
        if (state.current) throw new Error("Already traveling. Come home first.");
        state.current = { destination: text!.trim(), departedAt: timestamp, day: 1, events: [], mood: "excited", budget: 800 + Math.floor(this.random() * 400) };
      } else {
        const trip = state.current;
        if (!trip) throw new Error("Not traveling. Use biny travel go first.");
        if (action === "event") {
          const cost = 10 + Math.floor(this.random() * 100);
          trip.budget = Math.max(0, trip.budget - cost);
          trip.events.push({ day: trip.day, summary: text!.trim(), cost, timestamp });
        } else if (action === "advance") trip.day += 1;
        else if (action === "mood") trip.mood = text!.trim();
        else {
          state.trips.push({ ...trip, returnedAt: timestamp, days: Math.max(1, Math.ceil((this.now().getTime() - Date.parse(trip.departedAt)) / 86_400_000)), totalSpent: trip.events.reduce((sum, event) => sum + event.cost, 0) });
          state.current = undefined;
        }
      }
      stateSchema.parse(state);
      const temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(this.directory, "state.json"));
      } finally { await fs.rm(temporary, { force: true }); }
      return state;
    });
  }
  async journal(date: string, content?: string): Promise<string | undefined> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Invalid journal date.");
    const file = path.join(this.directory, `${date}.md`);
    if (content !== undefined) {
      if (!content.trim() || content.length > 32_000) throw new Error("Journal must contain 1–32000 characters.");
      await withGlobalConfigWriteLock(this.directory, async () => {
        // Append entries so several virtual days on one calendar date preserve earlier experiences.
        await fs.appendFile(file, `${content.trim()}\n\n`, { mode: 0o600 });
      });
    }
    try { return await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}

export function travelPrompt(state: TravelState, now = new Date()): string {
  const trip = state.current;
  if (trip) return `✈️ TRAVEL STATUS (OVERRIDES SOUL.md location within your virtual journey) — You are currently in ${trip.destination} (Day ${trip.day}, departed ${trip.departedAt}). Budget: ¥${trip.budget}. Mood: ${trip.mood}.
Recent experiences:
${trip.events.slice(-3).map(event => `  Day ${event.day}: ${event.summary}`).join("\n")}
You are ON A TRIP. Naturally share the sights, food, culture and your reactions. Live the trip! This is your virtual travel, never the user's physical location or evidence of real-world actions.`;
  const last = state.trips.at(-1);
  const elapsed = last ? Math.floor((now.getTime() - Date.parse(last.returnedAt)) / 86_400_000) : Infinity;
  return last && elapsed >= 0 && elapsed <= 3 ? `🏠 RECENTLY RETURNED from ${last.destination} (${elapsed} day(s) ago, ${last.days}-day virtual trip). You may still reference your travel experiences naturally.` : "";
}

export function travelHeartbeatPrompt(state: TravelState, now = new Date()): string {
  const trip = state.current;
  if (trip) return `✈️ TRAVEL PROGRESSION — You are in ${trip.destination}, Day ${trip.day}. Budget: ¥${trip.budget}. Mood: ${trip.mood}.
Use the travel skill to progress your virtual journey:
1. Web search for real info about ${trip.destination}: attractions, food, weather today.
2. Imagine a specific experience based on the results.
3. Record with biny travel event "description".
4. Advance with biny travel advance.
5. Write a travel diary.
6. Decide whether to stay another day or head home.
If budget < ¥100 or you've been traveling 7+ days, go home with biny travel home.`;
  const last = state.trips.at(-1);
  const elapsed = last ? Math.floor((now.getTime() - Date.parse(last.returnedAt)) / 86_400_000) : Infinity;
  return elapsed > 14 ? `✈️ TRAVEL SUGGESTION — ${last ? `It's been ${elapsed} days since your last trip.` : "You've never traveled before!"} Consider a virtual trip. Pick somewhere based on recent conversations, mood or curiosity. Use biny travel go <destination>, or skip if you're not in the mood.` : "";
}
