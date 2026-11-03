import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TravelStorage, travelPrompt, travelHeartbeatPrompt } from "../src/agent/context/travel.js";

async function withTrip(run: (storage: TravelStorage, root: string, setNow: (time: string) => void) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-travel-duration-"));
  let now = new Date("2026-10-18T10:00:00.000Z");
  const storage = new TravelStorage(root, () => now, () => 0.5);
  try { await run(storage, root, (time) => { now = new Date(time); }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("same-day virtual advances survive home, persisted history and the conversation prompt", async () => {
  await withTrip(async (storage, root) => {
    await storage.change("go", "Kyoto");
    for (let day = 1; day < 7; day += 1) await storage.change("advance");
    const before = await storage.read();
    assert.equal(before.current?.day, 7);
    const home = await storage.change("home");
    assert.equal(home.trips[0]?.days, 7);
    assert.equal(home.current, undefined);
    const restored = await new TravelStorage(root).read();
    assert.deepEqual(restored, home);
    assert.equal(JSON.parse(await readFile(path.join(root, "travels/history.json"), "utf8")).trips[0].days, 7);
    assert.match(travelPrompt(restored, new Date("2026-10-18T10:00:00Z")), /0 day\(s\) ago, 7-day virtual trip/u);
    await assert.rejects(storage.change("home"), /Not traveling/u);
    assert.equal((await storage.read()).trips.length, 1);
  });
});

test("elapsed real days do not advance a virtual trip", async () => {
  await withTrip(async (storage, _root, setNow) => {
    await storage.change("go", "Osaka");
    setNow("2026-10-23T10:00:00.000Z");
    const home = await storage.change("home");
    assert.equal(home.trips[0]?.day, 1);
    assert.equal(home.trips[0]?.days, 1);
    assert.equal(home.trips[0]?.departedAt, "2026-10-18T10:00:00.000Z");
    assert.equal(home.trips[0]?.returnedAt, "2026-10-23T10:00:00.000Z");
    assert.match(travelPrompt(home, new Date("2026-10-24T10:00:00Z")), /1 day\(s\) ago, 1-day virtual trip/u);
    assert.equal(travelPrompt(home, new Date("2026-10-27T10:00:00Z")), "");
    assert.match(travelHeartbeatPrompt(home, new Date("2026-11-07T10:00:00Z")), /TRAVEL SUGGESTION/u);
  });
});

test("event days, event costs and remaining budget are unchanged by virtual duration accounting", async () => {
  await withTrip(async (storage) => {
    await storage.change("go", "Nara");
    await storage.change("event", "First day garden");
    await storage.change("advance");
    await storage.change("advance");
    await storage.change("event", "Third day museum");
    const before = (await storage.read()).current!;
    const completed = (await storage.change("home")).trips[0]!;
    assert.equal(completed.days, 3);
    assert.deepEqual(completed.events, before.events);
    assert.deepEqual(completed.events.map(({ day, cost }) => ({ day, cost })), [{ day: 1, cost: 60 }, { day: 3, cost: 60 }]);
    assert.equal(completed.totalSpent, 120);
    assert.equal(completed.budget, 880);
    assert.equal(completed.mood, before.mood);
  });
});

test("a same-day trip without advance remains a one-day trip", async () => {
  await withTrip(async (storage) => {
    await storage.change("go", "Kobe");
    const completed = (await storage.change("home")).trips[0]!;
    assert.equal(completed.day, 1);
    assert.equal(completed.days, 1);
    assert.equal(completed.totalSpent, 0);
    assert.deepEqual(completed.events, []);
  });
});

test("existing history duration is not migrated or rewritten when a new trip returns", async () => {
  await withTrip(async (storage, root, setNow) => {
    await storage.change("go", "Old trip");
    await storage.change("home");
    const historyPath = path.join(root, "travels/history.json");
    const history = JSON.parse(await readFile(historyPath, "utf8"));
    history.trips[0].day = 5;
    history.trips[0].days = 2;
    const oldRecord = structuredClone(history.trips[0]);
    const legacyBytes = JSON.stringify(history, null, 2);
    await writeFile(historyPath, legacyBytes);
    assert.equal((await storage.read()).trips[0]?.days, 2);
    assert.equal(await readFile(historyPath, "utf8"), legacyBytes);
    assert.match(travelPrompt(await storage.read(), new Date("2026-10-18T10:00:00Z")), /2-day virtual trip/u);
    setNow("2026-10-19T10:00:00.000Z");
    await storage.change("go", "New trip");
    await storage.change("advance");
    await storage.change("advance");
    const home = await storage.change("home");
    assert.deepEqual(home.trips[0], oldRecord);
    assert.equal(home.trips[1]?.days, 3);
    assert.deepEqual((await new TravelStorage(root).read()).trips[0], oldRecord);
  });
});

test("interrupted home status recovery still recognizes the completed virtual trip", async () => {
  await withTrip(async (storage, root) => {
    await storage.change("go", "Sapporo");
    await storage.change("advance");
    const statusPath = path.join(root, "travels/status.json");
    const oldStatus = await readFile(statusPath, "utf8");
    await storage.change("home");
    await writeFile(statusPath, oldStatus);
    const recovered = await new TravelStorage(root).read();
    assert.equal(recovered.current, undefined);
    assert.equal(recovered.trips.length, 1);
    assert.equal(recovered.trips[0]?.days, 2);
    await assert.rejects(storage.change("home"), /Not traveling/u);
  });
});
