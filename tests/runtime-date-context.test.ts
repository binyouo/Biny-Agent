import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { estimateMessageTokens, estimateTokens } from "../src/agent/context/tokenUsage.js";
import type { AgentMessage, AgentModel } from "../src/agent/core/types.js";
import { buildPromptBundle, refreshRuntimeDateContext, stableSystemPromptForCache, stripTransientTurnContext } from "../src/agent/prompts.js";

test("the local date survives auxiliary-context omission and is charged to the input budget", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-date-budget-"));
  const previousZone = process.env.TZ;
  process.env.TZ = "Asia/Kathmandu";
  t.after(async () => {
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    await rm(root, { recursive: true, force: true });
  });
  const model: AgentModel = {
    provider: "fixture", modelId: "date-budget", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => { throw new Error("No model request expected"); }
  };
  const context = new ContextMemory(() => model, new WorkspaceContext(root, [], 4096), undefined,
    1000, 4096, undefined, undefined, { enabled: false, reserveTokens: 100 });
  context.replaceHistory([{ role: "user", content: "older context ".repeat(60) },
    { role: "assistant", content: [{ type: "text", text: "retained answer ".repeat(60) }] }]);
  const prompt = buildPromptBundle({ cwd: root, now: new Date("2026-10-08T18:15:00Z"),
    dailyNotesPrompt: "auxiliary notes ".repeat(3000) });
  const prepared = await context.prepareTurn("current task ".repeat(300), prompt, undefined, [], false);
  assert.match(prepared.systemPrompt ?? "", /Authoritative local date: 2026-10-09/u);
  assert.match(prepared.systemPrompt ?? "", /Weekday: Friday/u);
  assert.match(prepared.systemPrompt ?? "", /Timezone: UTC\+5:45/u);
  assert.doesNotMatch(JSON.stringify(prepared.messages), /Authoritative Local DateTime/u,
    "this fixture must exhaust the optional turn-context budget");
  const budget = (await context.status()).budget;
  assert.equal(budget.components?.find(component => component.id === "local date")?.disposition, "included");
  assert.equal(budget.usedTokens, estimateTokens(prepared.systemPrompt ?? "") + estimateMessageTokens(prepared.messages));
  assert.ok(budget.usedTokens <= budget.maxTokens - (budget.reserveTokens ?? 0));
  assert.doesNotMatch(stableSystemPromptForCache(prepared.systemPrompt), /DATE AWARENESS/u,
    "the changing local date must remain outside the stable cache prefix");
});

for (const sample of [
  { zone: "America/St_Johns", date: "2026-10-08", weekday: "Thursday", offset: "UTC-2:30", time: "21:30:01" },
  { zone: "UTC", date: "2026-10-09", weekday: "Friday", offset: "UTC+0", time: "00:00:01" }
]) {
  test(`clock refresh preserves canonical multimedia content and cache rules in ${sample.zone}`, t => {
    const previousZone = process.env.TZ;
    process.env.TZ = sample.zone;
    t.after(() => {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    });
    const original = [{ type: "image" as const, mimeType: "image/png", data: "fixture" },
      { type: "text" as const, text: "Literal <biny_reminder>keep this</biny_reminder>" }];
    const messages: AgentMessage[] = [{ role: "user", content: original, sentAt: "2026-10-07T15:59:59Z", sentAtTimeZone: "Asia/Shanghai" }];
    const first = refreshRuntimeDateContext("stable system rules", messages, new Date("2026-10-09T00:00:00Z"));
    const second = refreshRuntimeDateContext(first, messages, new Date("2026-10-09T00:00:01Z"));
    assert.ok(second.includes(`Authoritative local date: ${sample.date}`));
    assert.ok(second.includes(`Weekday: ${sample.weekday}`));
    assert.ok(second.includes(`Timezone: ${sample.offset}`));
    assert.equal(second.split("DATE AWARENESS (CRITICAL)").length - 1, 1);
    assert.equal(stableSystemPromptForCache(second), "stable system rules");
    const content = messages[0]!.content;
    assert.ok(Array.isArray(content));
    assert.ok(JSON.stringify(content[0]).includes(sample.time));
    assert.deepEqual(content.slice(1), original);
    assert.deepEqual(stripTransientTurnContext(messages), [{ role: "user", content: original,
      sentAt: "2026-10-07T15:59:59Z", sentAtTimeZone: "Asia/Shanghai" }]);
  });
}

for (const multimedia of [false, true]) {
  for (const truncated of [false, true]) {
    test(`refresh protects literal reminder tags with ${multimedia ? "multimedia" : "text"} and ${truncated ? "truncated" : "missing"} runtime time`, () => {
      const raw = "请保留 <biny_reminder>literal user text</biny_reminder>";
      const prefix = truncated
        ? '<!-- biny-turn-context:start -->\n<biny_reminder>Authoritative Local DateTime: 2025-01-01 [truncated]\n'
        : '<!-- biny-recalled-memory:start -->\nretained reference <biny_reminder>quoted reference</biny_reminder>\n<!-- biny-recalled-memory:end -->\n\n';
      const original = multimedia ? [{ type: "text" as const, text: raw }, { type: "image" as const, mimeType: "image/png", data: "fixture" }] : raw;
      const content = multimedia ? [{ type: "text" as const, text: prefix + raw }, { type: "image" as const, mimeType: "image/png", data: "fixture" }] : prefix + raw;
      const messages: AgentMessage[] = [{ role: "user", content, originalContent: original }];
      refreshRuntimeDateContext("rules", messages, new Date("2026-10-09T00:00:00Z"));
      const text = typeof messages[0]!.content === "string" ? messages[0]!.content : JSON.stringify(messages[0]!.content);
      assert.ok(text.includes(raw), "runtime refresh must not replace or delete literal user content");
      assert.match(text, /Authoritative Local DateTime: 2026-/u);
      assert.doesNotMatch(text, /2025-01-01/u);
      if (!truncated) assert.match(text, /retained reference <biny_reminder>quoted reference<\/biny_reminder>/u);
      assert.deepEqual(stripTransientTurnContext(messages), [{ role: "user", content: original }]);
    });
  }
}

test("date refresh preserves quoted runtime markers in project instructions", () => {
  const rules = "Project example:\n<!-- biny-runtime-context:start -->\nkeep this example\n<!-- biny-runtime-context:end -->\nEnd of project rules.";
  const first = refreshRuntimeDateContext(rules, [], new Date("2026-10-09T00:00:00Z"));
  const second = refreshRuntimeDateContext(first, [], new Date("2026-10-10T00:00:00Z"));
  assert.equal(stableSystemPromptForCache(second), rules);
  assert.equal(second.split("DATE AWARENESS (CRITICAL)").length - 1, 1);
});


for (const multimedia of [false, true]) {
  for (const truncated of [false, true]) {
    test(`real builder clock refresh replaces ${truncated ? "truncated" : "complete"} runtime reminders for ${multimedia ? "multimedia" : "text"}`, t => {
      const previousZone = process.env.TZ;
      process.env.TZ = "UTC";
      t.after(() => {
        if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
      });
      const raw = "Keep literal <biny_reminder>USER_LITERAL</biny_reminder> unchanged.";
      const original = multimedia
        ? [{ type: "text" as const, text: raw }, { type: "image" as const, mimeType: "image/png", data: "fixture" }]
        : raw;
      const bundle = buildPromptBundle({
        cwd: "/fixture",
        now: new Date("2026-10-07T23:59:59Z"),
        dailyNotesPrompt: "FILE_MEMORY_WITNESS",
        crystalPrompt: "REFERENCE_LITERAL <biny_reminder>QUOTED_LITERAL</biny_reminder>"
      });
      const endMarker = "<!-- biny-turn-context:end -->";
      const reminderEnd = bundle.turnContext.indexOf("</biny_reminder>");
      assert.ok(reminderEnd > 0);
      const runtime = truncated
        ? bundle.turnContext.slice(0, reminderEnd) + " [truncated]\n\n" + endMarker
        : bundle.turnContext;
      const retained = "\n\n<!-- biny-recalled-memory:start -->\nRETAINED_REFERENCE\n<!-- biny-recalled-memory:end -->\n\n";
      const prefix = runtime + retained;
      const content = multimedia
        ? [{ type: "text" as const, text: prefix + raw }, { type: "image" as const, mimeType: "image/png", data: "fixture" }]
        : prefix + raw;
      const messages: AgentMessage[] = [{
        role: "user", content, originalContent: original,
        sentAt: "2026-10-07T20:00:00Z", sentAtTimeZone: "UTC"
      }];
      let system = bundle.systemPrompt;
      for (const now of ["2026-10-08T00:00:00Z", "2026-10-09T00:00:01Z"]) {
        system = refreshRuntimeDateContext(system, messages, new Date(now));
        const message = messages[0]!;
        assert.ok(message.role === "user");
        const text = typeof message.content === "string" ? message.content : message.content[0]?.type === "text" ? message.content[0].text : "";
        assert.equal(text.split("Authoritative Local DateTime:").length - 1, 1);
        assert.doesNotMatch(text, /Authoritative Local DateTime: 2026-10-07/u);
        assert.ok(text.includes("Authoritative Local DateTime: " + now.slice(0, 10)));
        assert.ok(text.endsWith(retained + raw), "non-date trailing reference and original text remain byte-identical");
        if (!truncated) {
          assert.ok(text.includes("FILE_MEMORY_WITNESS"));
          assert.ok(text.includes("REFERENCE_LITERAL <biny_reminder>QUOTED_LITERAL</biny_reminder>"));
          const referenceStart = bundle.turnContext.indexOf("<biny_turn_context>");
          const referenceEnd = bundle.turnContext.lastIndexOf(endMarker);
          assert.ok(text.includes(bundle.turnContext.slice(referenceStart, referenceEnd)), "the full reference region remains byte-identical");
        }
        assert.deepEqual(message.originalContent, original);
        assert.equal(message.sentAt, "2026-10-07T20:00:00Z");
        assert.equal(message.sentAtTimeZone, "UTC");
        if (Array.isArray(message.content)) assert.deepEqual(message.content.slice(1), typeof original === "string" ? [] : original.slice(1));
        assert.deepEqual(stripTransientTurnContext(messages), [{
          role: "user", content: original, sentAt: "2026-10-07T20:00:00Z", sentAtTimeZone: "UTC"
        }]);
        assert.equal(system.split("DATE AWARENESS (CRITICAL)").length - 1, 1);
      }
    });
  }
}
