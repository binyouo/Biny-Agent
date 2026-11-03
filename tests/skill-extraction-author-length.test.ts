/** Explicitly incomplete author output must not replace a skill document. */
import assert from "node:assert/strict";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import { runSkillExtraction, type SkillExtractionNotice } from "../src/agent/skillExtraction.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { testModel } from "./helpers/model.js";

const name = "weekly-report";
const original = `---\nname: ${name}\ndescription: Original workflow.\n---\n\n# Workflow\n\n1. Read source.\n2. Preserve original mandatory validation ORIGINAL_TAIL.\n`;
const header = `---\nname: ${name}\ndescription: Updated workflow.\n---\n\n# Workflow\n\n`;
const partial = `${header}1. Before publishing, check the`;
const complete = `${header}1. Validate the report before publishing.\n`;
const events: SessionEvent[] = [{ type: "user_message", messageId: "m", content: "Update the report workflow." }];
for (let index = 0; index < 5; index += 1) {
  events.push({ type: "tool_call", tool: "Read", toolCallId: `t${String(index)}`, args: { path: "synthetic" } });
  events.push({ type: "tool_result", tool: "Read", toolCallId: `t${String(index)}`, result: "Synthetic data." });
}
events.push({ type: "assistant_message", content: "Complete." });

for (const update of [false, true]) {
  for (const scenario of [
    { label: "explicit length with partial body", reason: "length", body: partial, reject: true },
    { label: "explicit length with well-formed body", reason: "length", body: complete, reject: true },
    { label: "content-filter with partial body", reason: "content-filter", body: partial, reject: true },
    { label: "error with partial body", reason: "error", body: partial, reject: true },
    { label: "stop with the same short body", reason: "stop", body: partial, reject: false },
    { label: "other finish reason retains compatibility", reason: "other", body: complete, reject: false },
    { label: "missing provider finish retains compatibility", reason: "missing-finish", body: complete, reject: false }
  ] as const) {
    test(`${update ? "update" : "create"}: ${scenario.label}`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-author-length-"));
      t.after(async () => { await rm(root, { recursive: true, force: true }); });
      const managed = path.join(root, ".config", "biny", "skills");
      await mkdir(managed, { recursive: true });
      const directory = path.join(managed, name);
      const file = path.join(directory, "SKILL.md");
      if (update) { await mkdir(directory); await writeFile(file, original); }
      const prompts: string[] = [];
      const model = testModel({ provider: "test", modelId: "author-length", stream: async (context) => {
        prompts.push(context.systemPrompt ?? "");
        const analyst = prompts.length === 1;
        const text = analyst ? JSON.stringify({ worthy: true, skillName: name, skillDescription: "Report workflow.", existingSkillToUpdate: update ? name : null }) : scenario.body;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text };
          yield { type: "finish", reason: "stop", usage: { inputTokens: 100, outputTokens: analyst ? 40 : 4096, totalTokens: analyst ? 140 : 4196 } };
        })();
      } });
      // Only the synthetic provider boundary is adapted; the real SDK and native helper consume it.
      const provider = model.vercelModel;
      assert.ok(provider);
      const stream = provider.doStream.bind(provider);
      let requests = 0;
      provider.doStream = async (options) => {
        const author = ++requests === 2;
        const result = await stream(options);
        if (!author) return result;
        return { ...result, stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type !== "finish") { controller.enqueue(part); return; }
            if (scenario.reason === "missing-finish") return;
            controller.enqueue({ ...part, finishReason: { unified: scenario.reason, raw: scenario.reason } });
          }
        })) };
      };
      const notices: SkillExtractionNotice[] = [];
      let refreshes = 0;
      const operation = runSkillExtraction({ messageId: "m", events,
        installedSkills: update ? [{ name, description: "Original workflow.", filePath: file, scope: "global" }] : [],
        model, minToolCalls: 5, homeDir: root, onNotice: notice => notices.push(notice),
        refreshSkills: async () => { refreshes += 1; }
      });
      if (scenario.reject) {
        await assert.rejects(operation, /技能生成未完整完成/u);
        if (update) { assert.equal(await readFile(file, "utf8"), original); assert.deepEqual(await readdir(directory), ["SKILL.md"]); }
        else assert.deepEqual(await readdir(managed), []);
        assert.deepEqual(notices.map(notice => notice.stage), ["analyzing", "extracting", "failed"]);
        assert.equal(refreshes, 0);
      } else {
        const result = await operation;
        assert.equal(result.stage, "done");
        assert.equal(result.updated, update);
        assert.equal(await readFile(file, "utf8"), scenario.body.trim());
        assert.equal(refreshes, 1);
      }
      assert.equal(prompts.length, 2);
      assert.equal(prompts[1]!.includes("ORIGINAL_TAIL"), update);
    });
  }
}
