import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, systemPromptForTelemetry } from "../src/agent/prompts.js";
import { runSoulCommand } from "../src/agent/context/soulCommands.js";
import { SoulStorage } from "../src/agent/context/soulStorage.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-soul-test-"));
  const agent = path.join(root, "biny-agent");
  const soulPath = path.join(agent, "SOUL.md");

  try {
    const storage = new SoulStorage({ configDir: agent });
    const builtIn = await storage.read();
    assert.equal(builtIn.source, "builtin");
    assert.equal(builtIn.content, "");
    assert.equal(await storage.promptText(), undefined);
    await assert.rejects(fs.access(soulPath), /ENOENT/u);

    const saved = await storage.set("# Soul\n\nSpeak plainly and verify important claims.");
    assert.equal(saved.source, "user");
    assert.equal(await fs.readFile(soulPath, "utf8"), "# Soul\n\nSpeak plainly and verify important claims.\n");
    assert.match(await storage.promptText(), /Speak plainly and verify important claims/u);

    const evolved = await storage.appendTrait("Prefer a short concrete next step.");
    assert.match(evolved.content, /## Evolved Traits/u);
    assert.match(evolved.content, /- Prefer a short concrete next step\./u);
    assert.equal((await storage.appendTrait("Prefer a short concrete next step.")).content, evolved.content);

    const prompt = buildSystemPrompt({
      cwd: "/workspace",
      soulPrompt: await storage.promptText()
    });
    assert.match(prompt, /<biny_soul source="user">/u);
    assert.match(prompt, /Prefer a short concrete next step\./u);
    assert.match(prompt, /LANGUAGE RULE \(CRITICAL\)/u);
    assert.doesNotMatch(prompt, /<biny_soul source="builtin">/u);
    assert.doesNotMatch(prompt, /不代表 Biny 是人类/u);
    const telemetry = systemPromptForTelemetry(prompt);
    assert.ok(telemetry);
    assert.match(telemetry, /<biny_soul omitted="true" \/>/u);
    assert.doesNotMatch(telemetry, /Prefer a short concrete next step\./u);

    const show = await runSoulCommand(storage, ["show"]);
    assert.match(show, /Soul source: user override/u);
    const reset = await runSoulCommand(storage, ["delete"]);
    assert.match(reset, /Soul override removed/u);
    assert.equal((await storage.read()).source, "builtin");
    assert.equal(await storage.promptText(), undefined);
    await assert.rejects(fs.access(soulPath), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("soul tests passed");
}

void main();
