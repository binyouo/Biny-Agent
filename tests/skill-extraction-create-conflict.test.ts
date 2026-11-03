/** Automatic skill creation must not silently become an unrequested update. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import { runSkillExtraction, type SkillExtractionNotice } from "../src/agent/skillExtraction.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { testModel } from "./helpers/model.js";

const name = "weekly-report";
const original = `---\nname: ${name}\ndescription: Existing user report workflow.\n---\n\n# Report\n\nKeep the original review checklist ORIGINAL_USER_INSTRUCTION_SENTINEL.\n`;
const generated = `---\nname: ${name}\ndescription: Generated report workflow.\n---\n\n# Report\n\nUse the new generated procedure.\n`;
const events: SessionEvent[] = [{ type: "user_message", messageId: "m", content: "Create the weekly report." }];
for (let index = 0; index < 5; index += 1) {
  events.push({ type: "tool_call", tool: "Read", args: { path: "fixture" }, toolCallId: `fixture-${String(index)}` });
  events.push({ type: "tool_result", tool: "Read", toolCallId: `fixture-${String(index)}`, result: "Synthetic report data." });
}
events.push({ type: "assistant_message", content: "Report completed." });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-create-conflict-"));
  const directory = path.join(root, ".config", "biny", "skills", name);
  await mkdir(directory, { recursive: true });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, directory, file: path.join(directory, "SKILL.md") };
}

function replayModel(existingSkillToUpdate: string | null, beforeAuthor: () => Promise<void> = async () => undefined) {
  const prompts: string[] = [];
  const model = testModel({
    provider: "test", modelId: "successful-extraction",
    stream: async (context) => {
      prompts.push(context.systemPrompt ?? "");
      if (prompts.length === 2) await beforeAuthor();
      const text = prompts.length === 1
        ? JSON.stringify({ worthy: true, skillName: name, skillDescription: "Create a report.", existingSkillToUpdate })
        : generated;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop" };
      })();
    }
  });
  return { prompts, model };
}

const installed = (filePath: string) => [{ name, description: "Existing report workflow.", filePath, scope: "global" }];

for (const updateTarget of [null, "unknown-skill"]) {
  test(`create verdict ${String(updateTarget)} preserves an existing same-name skill`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.file, original);
    const replay = replayModel(updateTarget);
    const notices: SkillExtractionNotice[] = [];
    let refreshes = 0;
    await assert.rejects(runSkillExtraction({
      messageId: "m", events, installedSkills: installed(f.file), model: replay.model,
      minToolCalls: 5, homeDir: f.root, onNotice: notice => notices.push(notice),
      refreshSkills: async () => { refreshes += 1; }
    }), /同名技能已存在/u);
    assert.equal(await readFile(f.file, "utf8"), original);
    assert.equal(replay.prompts.length, 2);
    assert.ok(!replay.prompts[1]!.includes("ORIGINAL_USER_INSTRUCTION_SENTINEL"));
    assert.deepEqual(notices.map(notice => notice.stage), ["analyzing", "extracting", "failed"]);
    assert.equal(refreshes, 0);
  });
}

test("create preserves a same-name skill created while its author response is pending", async (t) => {
  const f = await fixture(t);
  const replay = replayModel(null, async () => { await writeFile(f.file, original); });
  await assert.rejects(runSkillExtraction({
    messageId: "m", events, installedSkills: [], model: replay.model, minToolCalls: 5, homeDir: f.root
  }), /同名技能已存在/u);
  assert.equal(await readFile(f.file, "utf8"), original);
});

test("ordinary creation still publishes a complete new document", async (t) => {
  const f = await fixture(t);
  await rm(f.directory, { recursive: true });
  const replay = replayModel(null);
  const outcome = await runSkillExtraction({
    messageId: "m", events, installedSkills: [], model: replay.model, minToolCalls: 5, homeDir: f.root
  });
  assert.equal(outcome.stage, "done");
  assert.equal(outcome.updated, false);
  assert.equal(outcome.installedPath, f.file);
  assert.equal(await readFile(f.file, "utf8"), generated.trim());
});

test("explicit matched update still supplies the old document and publishes its replacement", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, original);
  const replay = replayModel(name);
  const outcome = await runSkillExtraction({
    messageId: "m", events, installedSkills: installed(f.file), model: replay.model, minToolCalls: 5, homeDir: f.root
  });
  assert.equal(outcome.updated, true);
  assert.ok(replay.prompts[1]!.includes("ORIGINAL_USER_INSTRUCTION_SENTINEL"));
  assert.equal(await readFile(f.file, "utf8"), generated.trim());
});

test("explicit matched update still rejects an intervening edit", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, original);
  const changed = `${original}USER_EDIT_DURING_GENERATION\n`;
  const replay = replayModel(name, async () => { await writeFile(f.file, changed); });
  await assert.rejects(runSkillExtraction({
    messageId: "m", events, installedSkills: installed(f.file), model: replay.model, minToolCalls: 5, homeDir: f.root
  }), /改变/u);
  assert.equal(await readFile(f.file, "utf8"), changed);
});

test("creation in an existing ordinary directory preserves supporting files", async (t) => {
  const f = await fixture(t);
  const support = path.join(f.directory, "notes.txt");
  await writeFile(support, "USER_SUPPORTING_DATA");
  const replay = replayModel(null);
  const outcome = await runSkillExtraction({
    messageId: "m", events, installedSkills: [], model: replay.model, minToolCalls: 5, homeDir: f.root
  });
  assert.equal(outcome.updated, false);
  assert.equal(await readFile(support, "utf8"), "USER_SUPPORTING_DATA");
  assert.equal(await readFile(f.file, "utf8"), generated.trim());
});

test("two cooperating automatic creators publish only one same-name skill", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([replayModel(null), replayModel(null)].map(replay => runSkillExtraction({
    messageId: "m", events, installedSkills: [], model: replay.model, minToolCalls: 5, homeDir: f.root
  })));
  const successes = outcomes.filter(outcome => outcome.status === "fulfilled");
  const failures = outcomes.filter(outcome => outcome.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]!.reason), /同名技能已存在/u);
  assert.equal(successes[0]!.value.updated, false);
  assert.equal(await readFile(f.file, "utf8"), generated.trim());
});
