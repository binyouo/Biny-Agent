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
  ["overlong mood", { mood: "x".repeat(33) }],
  ["overlong Unicode mood", { mood: "😀".repeat(33) }],
  ["overlong trigger", { trigger: "x".repeat(201) }],
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

for (const patch of [{ mood: "x".repeat(33) }, { trigger: "😀".repeat(201) }]) {
  test(`context rejects oversized ${"mood" in patch ? "mood" : "trigger"} without losing previous state`, async () => fixture(async (storage) => {
    await storage.writeContext("session-one", valid);
    const before = await storage.readContext("session-one");
    const file = path.join(storage.directory, "context/session-one.md");
    const bytes = await readFile(file, "utf8");
    await assert.rejects(storage.writeContext("session-one", { ...valid, ...patch }), /Invalid emotion state/u);
    assert.deepEqual(await storage.readContext("session-one"), before);
    assert.equal(await readFile(file, "utf8"), bytes);
    assert.deepEqual(await readdir(path.dirname(file)), ["session-one.md"]);
  }));
}

test("valid Unicode boundary values retain trimming and context energy omission", async () => fixture(async (storage, root) => {
  const state = { ...valid, mood: `  ${"😀".repeat(32)}  `, trigger: `  ${"😀".repeat(200)}  ` };
  await storage.writeBase(state);
  await storage.writeContext("session-one", { ...state, energy: 2 });
  const expected = { ...state, mood: state.mood.trim(), trigger: state.trigger.trim() };
  assert.deepEqual(await new EmotionStorage({ configDir: root }).readBase(), expected);
  assert.deepEqual(await storage.readContext("session-one"), { ...expected, energy: 7 });
  assert.doesNotMatch(await readFile(path.join(storage.directory, "context/session-one.md"), "utf8"), /^energy:/mu);
}));

test("an invalid initial write does not create an unreadable base file", async () => fixture(async (storage) => {
  await assert.rejects(storage.writeBase({ ...valid, trigger: "x".repeat(201) }), /Invalid emotion state/u);
  assert.equal(await storage.readBase(), undefined);
  assert.deepEqual((await readdir(storage.directory)).filter(name => name.endsWith(".md") || name.endsWith(".tmp")), []);
}));

for (const scope of ["base", "context"] as const) {
  test(`actual CLI ${scope} command rejects unreadable output and retains the previous snapshot`, async () => fixture(async (storage, root) => {
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = root;
    try {
      await storage.writeBase(valid);
      await storage.writeContext("cli-session", valid);
      const before = scope === "base" ? await storage.readBase() : await storage.readContext("cli-session");
      const command = scope === "base"
        ? () => emotionSetBaseCommand("content", "7", "8", ["x".repeat(201)])
        : () => emotionSetContextCommand("cli-session", "x".repeat(33), "8", ["reason"]);
      await assert.rejects(command(), /Invalid emotion state/u);
      assert.deepEqual(scope === "base" ? await storage.readBase() : await storage.readContext("cli-session"), before);
    } finally {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
    }
  }));
}
