import type { ContextStatus } from "../src/agent/context/types.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedLoadedSkill } from "../src/desktop/renderer/src/loadedSkills.js";
import { buildSessionTimeline, createSessionTimelineProjector, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

const body = "# Skill: image-gen\n\n**Skill Directory:** `/bundled/image-gen`\n\n---\nDraw images.\n\n---\nFollow the instructions above for your response. Remember to use absolute paths when accessing files in the skill directory.";
const call: TimelineTool = { id: "skill", tool: "Skill", args: { skill: "image-gen" }, result: body, status: "success", executionStatus: "succeeded", updates: [] };
const timestamp = "2026-10-22T00:00:00.000Z";
function context(loadedSkills: string[]): ContextStatus {
  return { loadedSkills, memoryInjectedSummaries: [], loadedInstructions: [], instructionBytes: 0, instructionCapBytes: 0,
    snapshotDirty: false, repoMapDirty: false, repoMapEntries: 0, activePaths: [], recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0 }, budget: { maxTokens: 1000, usedTokens: 0, omitted: [], autoCompacted: false }, memoryEnabled: false };
}


test("confirmed loads require successful body evidence, not selection or missing legacy result", () => {
  for (const result of [body, { result: body, durationMs: 3 }, { result: body, hooks: [] }, { result: body, durationMs: 3, hooks: [] }]) {
    assert.equal(confirmedLoadedSkill({ ...call, result }), "image-gen");
    assert.equal(confirmedLoadedSkill({ ...call, result, executionStatus: undefined }), "image-gen");
  }
  for (const result of [undefined, "", " ", { result: body }, { result: body, unexpected: true }, { result: body, durationMs: Number.NaN }]) {
    assert.equal(confirmedLoadedSkill({ ...call, result }), undefined);
  }
  for (const result of ["Unknown skill: image-gen", "Permission denied", "not body", {}]) {
    assert.equal(confirmedLoadedSkill({ ...call, result, executionStatus: undefined }), undefined);
  }
  for (const status of ["running", "waiting", "failed", "denied", "aborted", "cancelled", "skipped", "unknown"] as const) {
    assert.equal(confirmedLoadedSkill({ ...call, status }), undefined);
  }
  for (const executionStatus of ["failed", "unknown", "cancelled"] as const) {
    assert.equal(confirmedLoadedSkill({ ...call, executionStatus, result: { loadedSkill: "image-gen" } }), undefined);
  }
});

test("host-owned full-resource and archive markers count; paths and ordinary resources do not", () => {
  for (const tool of ["read_skill_resource", "Skill", "skill_call"]) {
    for (const result of [...(tool === "read_skill_resource" ? [{ loadedSkill: "image-gen", skill: "image-gen", content: body }] : []), { loadedSkill: "image-gen", archived: true, archivePath: "archive.json" }, { loadedSkill: "image-gen", archived: true, archiveError: "full" }]) {
      assert.equal(confirmedLoadedSkill({ ...call, tool, result }), "image-gen");
    }
  }
  for (const tool of ["Read", "Bash", "run_script"]) {
    assert.equal(confirmedLoadedSkill({ ...call, tool, result: { loadedSkill: "image-gen" } }), undefined);
  }
  for (const result of [{ path: "SKILL.md", content: body }, { path: "references/guide.md", content: body }, { content: { loadedSkill: "image-gen" } }, { loadedSkill: "image-gen", status: "skipped" }]) {
    assert.equal(confirmedLoadedSkill({ ...call, tool: "read_skill_resource", result }), undefined);
  }
});

function runtime(runId: string, eventId: string, eventSeq: number) { return { runId, eventId, eventSeq }; }
function versions(): SessionEvent[] {
  return [
    { type: "user_message", messageId: "user", content: "draw", runtime: runtime("first", "u", 1) },
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["first-prompt"] }, runtime: runtime("first", "meta1", 2) },
    { type: "tool_call", tool: "Skill", toolCallId: "first-tool", args: { skill: "first-tool" }, runtime: runtime("first", "t", 3) },
    { type: "tool_result", tool: "Skill", toolCallId: "first-tool", result: "Full skill body", executionStatus: "succeeded", runtime: runtime("first", "tr", 4) },
    { type: "agent_message", messageId: "a1", parentMessageId: "user", slotId: "user", message: { role: "assistant", content: [{ type: "text", text: "first" }] }, runtime: runtime("first", "a1", 5) },
    { type: "assistant_message", messageId: "a1", parentMessageId: "user", replyToMessageId: "user", slotId: "user", content: "first", runtime: runtime("first", "flat1", 6) },
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["second-prompt"] }, runtime: runtime("second", "meta2", 7) },
    { type: "agent_message", messageId: "a2", parentMessageId: "user", slotId: "user", message: { role: "assistant", content: [{ type: "text", text: "second" }] }, runtime: runtime("second", "a2", 8) },
    { type: "assistant_message", messageId: "a2", parentMessageId: "user", replyToMessageId: "user", slotId: "user", content: "second", runtime: runtime("second", "flat2", 9) }
  ];
}

test("loaded metadata and successful calls belong only to the selected answer run", () => {
  for (const [messageId, expected] of [["a1", ["first-prompt", "first-tool"]], ["a2", ["second-prompt"]]] as const) {
    const events: SessionEvent[] = [...versions(), { type: "message_version_selected", messageId, slotId: "user" }];
    const projected = createSessionTimelineProjector().update({ sessionId: "session", events, liveEvents: [] });
    for (const turns of [buildSessionTimeline(events, []), projected]) {
      assert.deepEqual(turns[0]?.skills, expected);
      assert.equal(turns[0]?.assistantMessageId, messageId);
      assert.ok(turns[0]?.tools.some(tool => tool.id === "first-tool"), "general tool diagnostics are not changed by skill scoping");
    }
  }
  const noSecondLoad = versions().filter(event => event.type !== "message_metadata" || event.runtime?.runId !== "second");
  assert.deepEqual(buildSessionTimeline(noSecondLoad, [])[0]?.skills, []);
});

test("unambiguous old evidence survives but ambiguous runless version metadata does not", () => {
  const old: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "draw" },
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["old"] } },
    { type: "tool_call", tool: "Skill", toolCallId: "skill", args: { skill: "image-gen" } },
    { type: "tool_result", tool: "Skill", toolCallId: "skill", result: body }
  ];
  assert.deepEqual(buildSessionTimeline(old, [])[0]?.skills, ["old", "image-gen"]);
  const ambiguous = versions().map(event => ({ ...event, runtime: undefined }));
  assert.deepEqual(buildSessionTimeline(ambiguous, [])[0]?.skills, []);
  const failed: SessionEvent[] = [...old.map((event, i) => ({ ...event, runtime: runtime("failed", String(i), i + 1) })), { type: "error", message: "provider failed", runtime: runtime("failed", "end", 8) }];
  assert.deepEqual(buildSessionTimeline(failed, [])[0]?.skills, ["old", "image-gen"]);
});

test("nested resource loads and repeated context updates stay in their own live run", () => {
  const base = { sessionId: "session", runId: "live", timestamp };
  const events: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "draw" },
    { ...base, type: "context.updated", context: context(["prompt"]) },
    { ...base, type: "tool.started", toolCallId: "nested", parentToolCallId: "script", tool: "read_skill_resource", args: { skill: "image-gen", path: "SKILL.md" } },
    { ...base, type: "tool.completed", toolCallId: "nested", tool: "read_skill_resource", result: { loadedSkill: "image-gen", skill: "image-gen", content: body }, executionStatus: "succeeded" },
    { ...base, type: "context.updated", context: context([]) },
    { ...base, type: "context.updated", context: context(["prompt"]) }
  ];
  const projector = createSessionTimelineProjector();
  const before = projector.update({ sessionId: "session", events: [], liveEvents: events.slice(0, 2) });
  const after = projector.update({ sessionId: "session", events: [], liveEvents: events });
  assert.deepEqual(before[0]?.skills, ["prompt"], "published snapshots remain immutable");
  assert.deepEqual(after[0]?.skills, ["prompt", "image-gen"]);
  assert.deepEqual(buildSessionTimeline([], events)[0]?.skills, ["prompt", "image-gen"]);
  const retry: AgentHostEvent[] = [
    { ...base, type: "run.started", messageId: "retry-answer", retryOfMessageId: "a2", input: "draw", skills: [], model: { alias: "test", provider: "test", label: "test", reasoning: "" } },
    { ...base, type: "context.updated", context: context([]) }
  ];
  assert.deepEqual(buildSessionTimeline(versions(), retry)[0]?.skills, []);
});


test("only canonical old archive envelopes retain proven Skill loads", () => {
  const archivePath = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
  const large = body.replace("Draw images.", "x".repeat(40000));
  const excerpt = (value: string): string => `${value.slice(0, 300)}\n… [39000 bytes omitted] …\n${value.slice(-300)}`;
  for (const preview of [excerpt(large), excerpt(JSON.stringify({ result: large, durationMs: 12 }))]) {
    assert.equal(confirmedLoadedSkill({ ...call, result: { archived: true, archivePath, resultBytes: 40000, preview } }), "image-gen");
  }
  assert.equal(confirmedLoadedSkill({ ...call, result: { archived: true, archiveError: "disk full", resultBytes: 40000, result: { result: body, durationMs: 12 } } }), "image-gen");
  for (const result of [
    { archived: true, archivePath, resultBytes: 40000, preview: "image-gen loaded" },
    { archived: true, archivePath: "/random/file", resultBytes: 40000, preview: body },
    { archived: true, archivePath, resultBytes: 40000, preview: JSON.stringify({ nested: { result: body, durationMs: 1 } }) },
    { archived: true, archivePath, resultBytes: 40000, preview: JSON.stringify({ result: body }) },
    { loadedSkill: "../image-gen", archived: true },
    { loadedSkill: "image-gen", skill: "wrong", content: body }
  ]) assert.equal(confirmedLoadedSkill({ ...call, tool: result.archived ? "Skill" : "read_skill_resource", result }), undefined);
});

test("pre-user patches and duplicate user metadata do not create load facts", () => {
  const events: SessionEvent[] = [
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["before"] } },
    { type: "user_message", messageId: "user", content: "go", metadata: { loadedSkills: ["real"] } },
    { type: "user_message", messageId: "user", content: "duplicate", metadata: { loadedSkills: ["duplicate"] } }
  ];
  for (const turn of buildSessionTimeline(events, [])) assert.deepEqual(turn.skills, ["real"]);
});

test("a first failed run's unscoped facts cannot leak into its sole retry answer", () => {
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "go", runtime: runtime("failed", "u", 1) },
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["unscoped-first"] } },
    { type: "agent_message", messageId: "only-answer", parentMessageId: "user", slotId: "user", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, runtime: runtime("retry", "a", 2) },
    { type: "assistant_message", messageId: "only-answer", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "done", runtime: runtime("retry", "flat", 3) }
  ];
  assert.deepEqual(buildSessionTimeline(events, [])[0]?.skills, []);
});

test("a successful nested body read remains loaded when its parent script fails, live and replay", () => {
  const base = { sessionId: "session", runId: "run", timestamp };
  const result = { loadedSkill: "image-gen", skill: "image-gen", content: body };
  const live: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "draw" },
    { ...base, type: "tool.started", toolCallId: "script", tool: "run_script", args: { code: "read then throw" } },
    { ...base, type: "tool.started", toolCallId: "child", parentToolCallId: "script", tool: "read_skill_resource", args: { skill: "image-gen", path: "SKILL.md" } },
    { ...base, type: "tool.completed", toolCallId: "child", tool: "read_skill_resource", result, executionStatus: "succeeded" },
    { ...base, type: "tool.failed", toolCallId: "script", tool: "run_script", result: { error: "later script failure" }, error: "later script failure", executionStatus: "failed" }
  ];
  const history: SessionEvent[] = ([
    { type: "user_message", messageId: "user", content: "draw" },
    { type: "tool_call", toolCallId: "script", tool: "run_script", args: { code: "read then throw" } },
    { type: "tool_call", toolCallId: "child", parentToolCallId: "script", tool: "read_skill_resource", args: { skill: "image-gen", path: "SKILL.md" }, auditOnly: true },
    { type: "tool_result", toolCallId: "child", tool: "read_skill_resource", result, executionStatus: "succeeded", auditOnly: true },
    { type: "tool_result", toolCallId: "script", tool: "run_script", result: { error: "later script failure" }, executionStatus: "failed" }
  ] satisfies SessionEvent[]).map((event, index) => ({ ...event, runtime: runtime("run", String(index), index + 1) }));
  for (const turn of [buildSessionTimeline([], live)[0], buildSessionTimeline(history, [])[0]]) {
    assert.deepEqual(turn?.skills, ["image-gen"]);
    assert.equal(turn?.tools.find(tool => tool.id === "script")?.status, "failed");
    assert.equal(turn?.tools.find(tool => tool.id === "child")?.status, "success");
  }
  for (const invalid of [{ ...result, loadedSkill: "" }, { ...result, content: " " }, { ...result, skill: "other" }]) {
    assert.equal(confirmedLoadedSkill({ ...call, tool: "read_skill_resource", result: invalid }), undefined);
  }
  const archived = { archived: true, resultBytes: 40000, archivePath: `.biny/tool-results/tool-result-${"b".repeat(64)}.json`, preview: body };
  for (const executionStatus of ["failed", "unknown", "cancelled"] as const) {
    assert.equal(confirmedLoadedSkill({ ...call, result: archived, executionStatus }), undefined);
  }
});

test("a later zero-tool selection does not inherit the previous turn's actual loads", () => {
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "first-user", content: "test PTC code mode" },
    { type: "tool_call", toolCallId: "code-mode", tool: "Skill", args: { skill: "codemode-tool-calling" } },
    { type: "tool_result", toolCallId: "code-mode", tool: "Skill", result: "Code mode full instructions", executionStatus: "succeeded" },
    { type: "assistant_message", messageId: "first-answer", replyToMessageId: "first-user", content: "Testing code mode" },
    { type: "user_message", messageId: "second-user", content: "你在干啥" },
    { type: "message_metadata", messageId: "second-user", metadata: { capabilitySelection: { tools: "auto", skills: ["image-gen", "codemode-tool-calling"] } } },
    { type: "assistant_message", messageId: "second-answer", replyToMessageId: "second-user", content: "Explaining" }
  ];
  for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "session", events, liveEvents: [] })]) {
    assert.deepEqual(turns[0]?.skills, ["codemode-tool-calling"]);
    assert.deepEqual(turns[1]?.skills, []);
    assert.deepEqual(turns[1]?.tools, []);
    assert.deepEqual(turns[1]?.capabilitySelection?.skills, ["image-gen", "codemode-tool-calling"], "picker selections remain available without becoming loaded facts");
  }
});


test("intermediate assistant tool-call steps do not invent a second legacy answer version", () => {
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "draw" },
    { type: "message_metadata", messageId: "user", metadata: { loadedSkills: ["legacy-prompt"] } },
    { type: "agent_message", messageId: "step", parentMessageId: "user", slotId: "step", message: { role: "assistant", content: [{ type: "toolCall", id: "skill", name: "Skill", arguments: { skill: "image-gen" } }] } },
    { type: "tool_call", toolCallId: "skill", tool: "Skill", args: { skill: "image-gen" } },
    { type: "tool_result", toolCallId: "skill", tool: "Skill", result: body },
    { type: "agent_message", messageId: "result", parentMessageId: "step", slotId: "result", message: { role: "toolResult", toolCallId: "skill", toolName: "Skill", content: [{ type: "text", text: body }], isError: false } },
    { type: "agent_message", messageId: "answer", parentMessageId: "result", slotId: "user", replyToMessageId: "user", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "assistant_message", messageId: "answer", parentMessageId: "result", slotId: "user", replyToMessageId: "user", content: "done" }
  ];
  for (const turns of [buildSessionTimeline(events, []), createSessionTimelineProjector().update({ sessionId: "session", events, liveEvents: [] })]) {
    assert.deepEqual(turns[0]?.skills, ["legacy-prompt", "image-gen"]);
    assert.equal(turns[0]?.assistantMessageId, "answer");
  }
  const withRetry: SessionEvent[] = [...events,
    { type: "agent_message", messageId: "retry", parentMessageId: "user", slotId: "user", replyToMessageId: "user", message: { role: "assistant", content: [{ type: "text", text: "retry" }] } },
    { type: "assistant_message", messageId: "retry", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "retry" }
  ];
  assert.deepEqual(buildSessionTimeline(withRetry, [])[0]?.skills, [], "true runless answer-version ambiguity remains unknown");
});


test("the historical complete Skill instruction record remains load evidence, not bare instructions", () => {
  // Exact September producer shape; the coordinator adds summary fields by spreading objects.
  const historical = { skill: "image-gen", scope: "builtin", path: "bundled-skills/image-gen/SKILL.md", instructions: "Generate the requested image.",
    resourceRoot: "/app/bundled-skills/image-gen", resources: [{ path: "scripts/generate.py", kind: "script", size: 123 }, { path: "references/guide.md", kind: "reference", size: 0 }, { path: "assets/sample.png", kind: "asset", size: 10 }, { path: "notes.txt", kind: "file", size: 4 }] };
  for (const tool of ["Skill", "skill_call"]) {
    for (const result of [historical, { ...historical, durationMs: 4, hooks: [], truncated: false }]) {
      for (const executionStatus of [undefined, "succeeded"] as const) {
        assert.equal(confirmedLoadedSkill({ ...call, tool, result, executionStatus, args: { skill: " IMAGE-GEN " } }), "image-gen");
      }
    }
  }
  assert.equal(confirmedLoadedSkill({ ...call, result: historical, executionStatus: undefined, args: {} }), "image-gen");
  const partials: unknown[] = [{ instructions: "Use tools." }, { ...historical, skill: "../image-gen" }, { ...historical, scope: "remote" },
    { ...historical, path: "" }, { ...historical, instructions: " " }, { ...historical, resourceRoot: null }, { ...historical, resources: undefined },
    { ...historical, resources: [{ path: "a", kind: "invalid", size: 2 }] }, { ...historical, resources: [{ path: "a", kind: "file", size: -1 }] },
    { ...historical, resources: [{ path: "a", kind: "file", size: Number.NaN }] }, { ...historical, resources: [{ path: "a", kind: "file", size: 1.5 }] },
    { ...historical, resources: [{ path: " ", kind: "file", size: 1 }] }, { ...historical, resources: [null] }, { result: historical, durationMs: 4 },
    { ...historical, durationMs: Number.NaN }, { ...historical, hooks: "invalid" }, { ...historical, error: "failed" }, { ...historical, status: "skipped" }, { ...historical, executionStatus: "unknown" }, { ...historical, executionStatus: "failed" }, { ...historical, executionStatus: "cancelled" }];
  for (const result of partials) {
    assert.equal(confirmedLoadedSkill({ ...call, result }), undefined);
    assert.equal(confirmedLoadedSkill({ ...call, result, executionStatus: undefined }), undefined);
  }
  assert.equal(confirmedLoadedSkill({ ...call, result: historical, args: { skill: "different" } }), undefined);
  for (const tool of ["Read", "Bash", "read_skill_resource"]) assert.equal(confirmedLoadedSkill({ ...call, tool, result: historical }), undefined);
  for (const executionStatus of ["failed", "unknown", "cancelled"] as const) assert.equal(confirmedLoadedSkill({ ...call, executionStatus, result: historical }), undefined);
  const history: SessionEvent[] = [
    { type: "user_message", messageId: "legacy-user", content: "draw" },
    { type: "tool_call", tool: "Skill", toolCallId: "legacy", args: { skill: "image-gen" } },
    { type: "tool_result", tool: "Skill", toolCallId: "legacy", result: historical }
  ];
  assert.deepEqual(buildSessionTimeline(history, [])[0]?.skills, ["image-gen"]);
});


test("the known old archive failure envelope preserves one complete retained Skill record", () => {
  const retained = { skill: "image-gen", scope: "builtin", path: "bundled-skills/image-gen/SKILL.md", instructions: "x".repeat(40000),
    resourceRoot: "/app/bundled-skills/image-gen", resources: [], durationMs: 3, truncated: false, hooks: [] };
  const envelope = { archived: true, resultBytes: 40500, archiveError: "disk full", result: retained };
  assert.equal(confirmedLoadedSkill({ ...call, result: envelope }), "image-gen");
  for (const result of [{ instructions: "x".repeat(40000) }, { ...retained, error: "failed" }, { ...retained, status: "failed" },
    { ...retained, status: "unknown" }, { ...retained, executionStatus: "unknown" }, { ...retained, executionStatus: "failed" },
    { ...retained, executionStatus: "cancelled" }, { ...retained, resources: [{ path: "a", kind: "file", size: -1 }] }, envelope]) {
    assert.equal(confirmedLoadedSkill({ ...call, result: { ...envelope, result } }), undefined);
  }
  for (const executionStatus of [undefined, "failed", "unknown", "cancelled"] as const) {
    assert.equal(confirmedLoadedSkill({ ...call, executionStatus, result: envelope }), undefined);
  }
  for (const result of [{ result: retained }, { ...envelope, archived: false }, { ...envelope, resultBytes: 0 },
    { ...envelope, resultBytes: Number.NaN }, { ...envelope, archiveError: undefined },
    { archived: true, resultBytes: 40500, archivePath: `.biny/tool-results/tool-result-${"a".repeat(64)}.json`, preview: JSON.stringify(retained) }]) {
    assert.equal(confirmedLoadedSkill({ ...call, result }), undefined);
  }
  assert.equal(confirmedLoadedSkill({ ...call, result: envelope, args: { skill: "other" } }), undefined);
  assert.equal(confirmedLoadedSkill({ ...call, result: envelope, tool: "Read" }), undefined);
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "draw" },
    { type: "tool_call", tool: "Skill", toolCallId: "skill", args: { skill: "image-gen" } },
    { type: "tool_result", tool: "Skill", toolCallId: "skill", executionStatus: "succeeded", result: envelope }
  ];
  assert.deepEqual(buildSessionTimeline(events, [])[0]?.skills, ["image-gen"]);
});
