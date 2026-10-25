import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { activitySettingsPatchSchema } from "../src/activity/settings.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { globalPersonalizationUpdateSchema } from "../src/personalization/index.js";
import { computerActionSchema, computerSequenceSchema, windowObserveSchema } from "../src/computer/protocol.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { openAiCompatibleToolParameters, validateJsonSchema } from "../src/tools/schema.js";
import { zodToolInput } from "../src/tools/zodToolInput.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIndependent(left: unknown, right: unknown): void {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return;
  assert.notEqual(left, right, "Separate parses must not share mutable defaults");
  if (Array.isArray(left) && Array.isArray(right)) left.forEach((value, index) => assertIndependent(value, right[index]));
  else if (isRecord(left) && isRecord(right)) for (const key of Object.keys(left)) assertIndependent(left[key], right[key]);
}

test("settings updates preserve omitted fields and normalize only supplied values", () => {
  for (const [input, expected] of [
    [{}, {}], [{ enabled: false }, { enabled: false }], [{ enabled: undefined }, { enabled: undefined }],
    [{ captureDebounceMs: 0 }, { captureDebounceMs: 0 }], [{ ocrLanguages: [" en-US "] }, { ocrLanguages: ["en-US"] }],
    [{ outputDirectory: " /synthetic/path " }, { outputDirectory: "/synthetic/path" }],
    [{ sensitiveApplications: [] }, { sensitiveApplications: [] }]
  ]) assert.deepEqual(activitySettingsPatchSchema.parse(input), expected);
  for (const input of [null, [], { unknown: true }, { enabled: null }, { captureDebounceMs: -1 }, { captureDebounceMs: 30_001 }, { ocrLanguages: [] }]) {
    assert.equal(activitySettingsPatchSchema.safeParse(input).success, false);
  }
  const revisions = { expectedPreferenceRevision: 0, expectedConfigRevision: "test-revision" };
  for (const [update, base, keys] of [
    [settingsSaveInputSchema, revisions, ["memory", "compaction", "chatParams"]],
    [globalPersonalizationUpdateSchema, {}, ["memory"]]
  ] as const) {
    assert.deepEqual(update.parse(base), base);
    for (const key of keys) {
      assert.deepEqual(update.parse({ ...base, [key]: undefined }), { ...base, [key]: undefined });
      assert.equal(update.safeParse({ ...base, [key]: null }).success, false);
      const expanded: unknown = update.parse({ ...base, [key]: {} });
      assert.ok(isRecord(expanded) && isRecord(expanded[key]) && Object.keys(expanded[key]).length > 0);
    }
  }
});

test("configuration defaults are fully parsed and do not share mutable state", () => {
  const input = { ...defaultConfig, permission: undefined, chat: undefined, crystal: undefined,
    extensions: undefined, hooks: undefined, diagnostics: undefined, web: undefined,
    activity: undefined, context: undefined, computer: undefined };
  const first = configSchema.parse(input), second = configSchema.parse(input);
  assert.deepEqual(first, second);
  assertIndependent(first, second);
  assert.equal(first.context.memory.sleepEnabled, true);
  assert.equal(first.context.memory.sleepTime, "03:00");
  assert.equal(first.context.memory.llmBatchSize, 20);
  const model = defaultConfig.models[defaultConfig.defaultModel]!;
  for (const [reasoning, valid] of [
    [{ mapping: { high: "high" }, budgetTokens: { high: 1024 } }, true],
    [{ mapping: { other: "high" } }, false]
  ] as const) {
    assert.equal(configSchema.safeParse({ ...defaultConfig,
      models: { ...defaultConfig.models, [defaultConfig.defaultModel]: { ...model, reasoning } }
    }).success, valid);
  }
});

test("computer action and sequence schemas retain cross-field validation", () => {
  const identity = { pid: 1, windowId: "1", captureId: "synthetic" };
const actionCases: [Record<string, unknown>, boolean][] = [
  [{ action: "click" }, false], [{ action: "click", x: 1, y: 2 }, true], [{ action: "click", x: 1 }, false],
  [{ action: "type_text", text: "" }, true], [{ action: "type_text", text: "a", inputMethod: "ax" }, false],
  [{ action: "type_text", text: "a", inputMethod: "ax", elementToken: "t" }, true],
  [{ action: "press_key", key: "Enter" }, true], [{ action: "press_key" }, false],
  [{ action: "scroll", direction: "down", x: 1, y: 2 }, true],
  [{ action: "set_value", elementToken: "t", value: false }, true],
  [{ action: "select_text", elementToken: "t", matchText: "a", text: "b" }, false]
];
  for (const [action, valid] of actionCases) {
    assert.equal(computerActionSchema.safeParse({ ...identity, ...action }).success, valid);
    assert.equal(computerSequenceSchema.safeParse({ ...identity, actions: [action] }).success, valid);
  }
  for (const [actions, valid] of [
    [[{ action: "click", x: 1, y: 2 }, { action: "click", x: 1, y: 2 }], false],
    [[{ action: "click", x: 1, y: 2 }, { action: "press_key", key: "Enter" }], true],
    [[{ action: "click", x: 1, y: 2 }, { action: "type_text", text: "x", elementToken: "stale" }], false],
    [[], false], [Array(6).fill({ action: "press_key", key: "Enter" }), false]
  ] as const) assert.equal(computerSequenceSchema.safeParse({ ...identity, actions }).success, valid);
  assert.equal(windowObserveSchema.safeParse({ pid: 1, windowId: "1", content: "image", waitFor: { text: "x" } }).success, false);
});

const cases: Record<string, [unknown, boolean][]> = {
  hashlineEditArgsSchema: [
    [{ operation: "delete", path: "x" }, true], [{ operation: "move", path: "x", to: "y" }, true],
    [{ operation: "update", path: "x", edits: [{ op: "replace", pos: "1#abc", lines: ["a"] }] }, true],
    [{ operation: "update", path: "x", edits: [{ op: "append", lines: [] }, { op: "prepend", lines: ["b"] }] }, true],
    [{ operation: "move", path: "x" }, false], [{ operation: "delete", path: "x", to: "y" }, false],
    [{ operation: "update", path: "x", edits: [{ op: "replace", lines: [] }] }, false],
    [{ operation: "update", path: "x", edits: [{ lines: [] }] }, false], [{ operation: "update", path: "x", edits: [] }, false]
  ],
  stringEditArgsSchema: [[{ path: "x", old_string: "a", new_string: "b" }, true], [{ operation: "delete", path: "x" }, true], [{ operation: "move", path: "x" }, false]],
  patchArgsSchema: [
    [{ callId: "a", operation: { type: "create_file", path: "x", diff: "+a" } }, true],
    [{ callId: "a", operation: { type: "update_file", path: "x", diff: "@@\n-a\n+b" } }, true],
    [{ callId: "a", operation: { type: "delete_file", path: "x" } }, true],
    [{ callId: "a", operation: { type: "delete_file", path: "x", diff: "bad" } }, false],
    [{ callId: "a", operation: { type: "create_file", path: "x" } }, false],
    [{ callId: "a", operation: { path: "x", diff: "+a" } }, false]
  ]
};

for (const [name, inputs] of Object.entries(cases)) {
  test(`${name} publishes the same accepted and rejected inputs through the SDK`, () => {
    const context = { workspaceRoot: process.cwd(), ignore: [] };
    const tool = name === "patchArgsSchema" ? createApplyPatchTool(context)
      : createEditFileTool(context, name === "hashlineEditArgsSchema");
    const wire = openAiCompatibleToolParameters(tool.name, tool.parameters);
    for (const [input, valid] of inputs) {
      assert.equal(tool.schema.safeParse(input).success, valid, JSON.stringify(input));
      assert.equal(validateJsonSchema(tool.parameters, input).ok, valid, JSON.stringify(input));
      assert.equal(validateJsonSchema(wire, input).ok, valid, JSON.stringify(input));
    }
  });
}

test("nested discriminated unions retain required fields and sibling constraints", () => {
  const schema = z.object({ items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), value: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("b"), count: z.number().min(1) }).strict()
  ])).min(1) }).strict();
  const { parameters } = zodToolInput(schema);
  for (const [input, valid] of [
    [{ items: [{ kind: "a", value: "x" }] }, true],
    [{ items: [{ kind: "b", count: 1 }] }, true],
    [{ items: [{ kind: "a" }] }, false],
    [{ items: [{ kind: "b", count: 0 }] }, false],
    [{ items: [{ kind: "c", value: "x" }] }, false],
    [{ items: [{ kind: "a", value: "x", extra: true }] }, false],
    [{ items: [] }, false], [{ items: [{ kind: "a", value: "x" }], extra: true }, false]
  ] as const) {
    assert.equal(schema.safeParse(input).success, valid);
    assert.equal(validateJsonSchema(parameters, input).ok, valid);
  }
});

test("patched Zod rejects oversized collections before parsing their elements", () => {
  for (const kind of ["array", "set"] as const) {
    let elementCalls = 0;
    const item = z.string().superRefine(() => { elementCalls += 1; });
    const result = kind === "array" ? z.array(item).max(2).safeParse(["a", "b", "c"])
      : z.set(item).max(2).safeParse(new Set(["a", "b", "c"]));
    assert.equal(result.success, false);
    assert.equal(elementCalls, 0);
  }
});
