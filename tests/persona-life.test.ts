import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { TravelStorage, travelPrompt, travelHeartbeatPrompt } from "../src/agent/context/travel.js";
import { SelfieAlbum } from "../src/agent/context/selfie.js";
import { seasonalPrompt } from "../src/agent/context/personaPrompt.js";
import { registerPersonaCommands } from "../src/cli/commands/persona.js";
import { HeartbeatScheduler } from "../src/agent/context/heartbeat.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test("virtual journey persists across instances, serializes concurrent events and returns home once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-travel-"));
  let now = new Date("2026-10-18T10:00:00Z");
  const storage = new TravelStorage(root, () => now, () => 0.5);
  try {
    assert.match(travelHeartbeatPrompt(await storage.read(), now), /never traveled/u);
    await assert.rejects(storage.change("advance"), /Not traveling/u);
    assert.equal((await storage.change("go", "京都")).current?.budget, 1000);
    await assert.rejects(storage.change("go", "东京"), /Already traveling/u);
    await Promise.all([storage.change("event", "寺院散步"), new TravelStorage(root, () => now, () => 0.5).change("event", "读到传统工艺的故事")]);
    await storage.change("advance");
    await storage.change("mood", "content");
    const state = await new TravelStorage(root).read();
    assert.equal(state.current?.day, 2);
    assert.equal(state.current?.events.length, 2);
    assert.equal(state.current?.budget, 880);
    assert.match(travelPrompt(state, now), /京都.*Day 2/su);
    const prompts: string[] = [];
    const heartbeat = new HeartbeatScheduler({ configDir: root, now: () => now, run: prompt => { prompts.push(prompt); } });
    try { assert.equal(await heartbeat.triggerNow(), true); }
    finally { heartbeat.stop(); }
    assert.match(prompts[0]!, /TRAVEL PROGRESSION.*京都/su);
    await storage.journal("2026-10-18", "第一段经历");
    await storage.journal("2026-10-18", "第二段感受");
    assert.equal(await storage.journal("2026-10-18"), "第一段经历\n\n第二段感受\n\n");
    await assert.rejects(storage.journal("../../outside", "x"), /Invalid/u);
    now = new Date("2026-10-20T10:00:00Z");
    const home = await storage.change("home");
    assert.equal(home.current, undefined);
    assert.equal(home.trips.length, 1);
    assert.equal(home.trips[0]?.totalSpent, 120);
    assert.match(travelPrompt(home, now), /RECENTLY RETURNED/u);
    await assert.rejects(storage.change("home"), /Not traveling/u);
    assert.equal((await storage.read()).trips.length, 1);
    assert.equal(travelPrompt(home, new Date("2026-10-24T10:00:00Z")), "");
    assert.equal(travelHeartbeatPrompt(home, new Date("2026-11-03T10:00:00Z")), "");
    assert.match(travelHeartbeatPrompt(home, new Date("2026-11-04T10:00:00Z")), /TRAVEL SUGGESTION/u);
    await writeFile(path.join(root, "travels", "state.json"), "broken");
    await assert.rejects(storage.change("go", "北京"));
    assert.equal(await readFile(path.join(root, "travels", "state.json"), "utf8"), "broken", "corrupt state must never reset silently");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selfie album requires explicit save, rejects non-images, and uses a real reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-selfie-"));
  try {
    const album = new SelfieAlbum(root, () => 0);
    assert.deepEqual((await album.prepare("笑着自拍")).reference, []);
    const source = path.join(root, "approved.png");
    await writeFile(source, pixel);
    const saved = await album.save(source);
    assert.deepEqual(await readFile(saved), pixel);
    await symlink(source, path.join(album.directory, "zz-link.png"));
    assert.deepEqual((await album.prepare("困倦，靠着枕头")).reference, [saved]);
    assert.equal((await album.list()).length, 1, "preparing generation does not add album photos or follow symlink entries");
    for (let i = 0; i < 5; i += 1) await album.save(source);
    const references = await album.list();
    assert.deepEqual((await album.prepare("开心地挥手")).reference, references.slice(0, 5));
    assert.deepEqual((await new SelfieAlbum(root, () => 0.999).prepare("换个角度")).reference, references.slice(1).reverse());
    assert.deepEqual(await album.list(), references);
    await writeFile(source, "not an image");
    await assert.rejects(album.save(source), /Expected a PNG/u);
    await assert.rejects(album.prepare(" "), /must not be empty/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI registration executes virtual travel and album commands against isolated state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-persona-cli-"));
  const old = process.env.BINY_AGENT_DIR;
  const log = console.log;
  const outputs: string[] = [];
  process.env.BINY_AGENT_DIR = root;
  console.log = value => { outputs.push(String(value)); };
  try {
    const run = async (args: string[]) => {
      const program = new Command().exitOverride();
      registerPersonaCommands(program, root);
      await program.parseAsync(args, { from: "user" });
    };
    await run(["travel", "go", "杭州", "--json"]);
    await run(["travel", "event", "西湖边想起一段对话"]);
    await run(["travel", "journal", "2026-10-18", "--text", "湖面很安静。"]);
    await run(["travel", "home"]);
    await run(["travel", "history"]);
    assert.equal(JSON.parse(outputs.at(-1)!)[0].destination, "杭州");
    await run(["selfie", "count"]);
    assert.equal(outputs.at(-1), "0");
  } finally {
    console.log = log;
    if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("Christmas greeting window respects local date and starts at 18:30 on Christmas Eve", () => {
  for (const date of [new Date(2026, 11, 24, 18, 29), new Date(2026, 11, 26), new Date(2026, 10, 25)]) assert.equal(seasonalPrompt(date), "");
  for (const date of [new Date(2026, 11, 24, 18, 30), new Date(2026, 11, 25, 23, 59)]) {
    assert.match(seasonalPrompt(date), /CHRISTMAS EASTER EGG/u);
    assert.match(seasonalPrompt(date), /For a task.*without the festive prefix/su);
  }
});
