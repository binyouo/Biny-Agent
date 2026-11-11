import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { emotionSetBaseCommand, emotionSetContextCommand } from "../src/cli/commands/emotion.js";
import type { EmotionState } from "../src/agent/context/emotionTypes.js";

const valid: EmotionState = { mood: "content", energy: 7, valence: 8, updatedAt: "2026-10-30T10:00:00Z", trigger: "Keep this state" };
async function fixture(run: (storage: EmotionStorage, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-write-"));
  try { await run(new EmotionStorage({ configDir: root }), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const [name, patch] of [
  ["empty mood", { mood: "   " }],
  ["invalid valence", { valence: 11 }],
  ["invalid energy", { energy: Number.NaN }],
  ["invalid timestamp", { updatedAt: "not-a-date" }]
] as const) {
  test(`base rejects ${name} before replacing its readable snapshot`, async () => fixture(async (storage) => {
    await storage.writeBase(valid);
    const file = path.join(storage.directory, "base.md");
    const before = await readFile(file, "utf8");
    await assert.rejects(storage.writeBase({ ...valid, ...patch }), /Invalid emotion state/u);
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(await storage.readBase(), valid);
    assert.deepEqual((await readdir(storage.directory)).filter(name => name.endsWith(".md") || name.endsWith(".tmp")), ["base.md"]);
  }));
}

test("long emotion descriptions retain trimming and context energy omission", async () => fixture(async (storage, root) => {
  const state = { ...valid, mood: `  ${"😀".repeat(80)}  `, trigger: `  ${"😀".repeat(1200)}  ` };
  await storage.writeBase(state);
  await storage.writeContext("session-one", { ...state, energy: 2 });
  const expected = { ...state, mood: state.mood.trim(), trigger: state.trigger.trim() };
  assert.deepEqual(await new EmotionStorage({ configDir: root }).readBase(), expected);
  assert.deepEqual(await storage.readContext("session-one"), { ...expected, energy: 7 });
  assert.doesNotMatch(await readFile(path.join(storage.directory, "context/session-one.md"), "utf8"), /^energy:/mu);
}));

test("an invalid initial write does not create an unreadable base file", async () => fixture(async (storage) => {
  await assert.rejects(storage.writeBase({ ...valid, valence: Number.NaN }), /Invalid emotion state/u);
  assert.equal(await storage.readBase(), undefined);
  assert.deepEqual((await readdir(storage.directory)).filter(name => name.endsWith(".md") || name.endsWith(".tmp")), []);
}));

for (const scope of ["base", "context"] as const) {
  test(`actual CLI ${scope} command preserves long mood descriptions`, async () => fixture(async (storage, root) => {
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = root;
    try {
      await storage.writeBase(valid);
      await storage.writeContext("cli-session", valid);
      const command = scope === "base"
        ? () => emotionSetBaseCommand("content", "7", "8", ["x".repeat(201)])
        : () => emotionSetContextCommand("cli-session", "x".repeat(33), "8", ["reason"]);
      await command();
      const saved = scope === "base" ? await storage.readBase() : await storage.readContext("cli-session");
      assert.equal(saved?.trigger, scope === "base" ? "x".repeat(201) : "reason");
      assert.equal(saved?.mood, scope === "base" ? "content" : "x".repeat(33));
    } finally {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
    }
  }));
}
