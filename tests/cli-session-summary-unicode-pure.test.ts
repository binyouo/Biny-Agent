import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { SessionSummary } from "../src/session/events.js";
import type { SessionCatalogPage, SessionCatalogQuery } from "../src/session/catalog.js";
import type { SessionsCommandOptions } from "../src/cli/commands/sessions.js";

// Read source text only. No production module, CLI, directory or catalog executes.
// Use identical fixture bytes in independent baseline and repaired source directories.
const sourcePath = new URL("../src/cli/commands/sessions.ts", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
for (const declaration of [
  'import { ensureAgentDirs } from "../../session/store.js";',
  'import { querySessionCatalog, type SessionBranchPoint, type SessionCatalogPage } from "../../session/catalog.js";',
  'import type { SessionSummary } from "../../session/events.js";'
]) {
  assert.equal(source.split(declaration).length, 2, `Expected exactly one import: ${declaration}`);
  source = source.replace(declaration, "");
}
for (const declaration of [
  "export interface SessionsCommandOptions",
  "export async function sessionsCommand",
  "export function printSessionCatalogPage",
  "export function printSessionSummaries"
]) {
  assert.equal(source.split(declaration).length, 2, `Expected exactly one export: ${declaration}`);
  source = source.replace(declaration, declaration.slice("export ".length));
}
assert.doesNotMatch(source, /^\s*(?:import|export)\b/mu, "Unexpected module dependency/export");
const executable = stripTypeScriptTypes(source, { mode: "strip" });
const now = Date.parse("2026-10-24T12:00:00.000Z");

interface Api {
  sessionsCommand(root: string, options?: SessionsCommandOptions): Promise<void>;
  printSessionCatalogPage(page: SessionCatalogPage): void;
  printSessionSummaries(summaries: SessionSummary[]): void;
}
type Call = { name: "ensure"; root: string }
  | { name: "query"; root: string; options: SessionCatalogQuery };

function harness(page: SessionCatalogPage = pageOf(summary("hello", "world"))) {
  const lines: string[] = [];
  const calls: Call[] = [];
  class FixedDate extends Date {
    static override now(): number { return now; }
  }
  const api = runInNewContext(
    `${executable}\n({ sessionsCommand, printSessionCatalogPage, printSessionSummaries });`,
    {
      Date: FixedDate,
      console: { log: (...values: unknown[]) => {
        assert.equal(values.length, 1, "Print calls retain one string argument");
        assert.equal(typeof values[0], "string");
        lines.push(values[0] as string);
      } },
      ensureAgentDirs: async (root: string): Promise<void> => { calls.push({ name: "ensure", root }); },
      querySessionCatalog: async (root: string, options: SessionCatalogQuery): Promise<SessionCatalogPage> => {
        calls.push({ name: "query", root, options: { ...options } });
        return page;
      }
    },
    { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }
  ) as Api;
  return { api, lines, calls };
}

function summary(user: string, assistant: string): SessionSummary {
  return {
    fileName: "synthetic.jsonl", createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z", eventCount: 2,
    firstUserMessage: user, lastAssistantMessage: assistant
  };
}

function pageOf(value: SessionSummary): SessionCatalogPage {
  return { revision: "synthetic-revision", items: [{
    id: "synthetic", fileName: value.fileName, rootSessionId: "synthetic",
    hasChildren: false, summary: value
  }] };
}

function expectedLines(user: string, assistant: string): string[] {
  return ["synthetic.jsonl\t2026-10-24T10:00:00.000Z\t2h ago\t2 events", `  user: ${user}`, `  biny: ${assistant}`];
}

function assertLines(actual: string[], expected: string[]): void {
  assert.deepEqual(actual, expected);
  for (const line of actual) {
    assert.equal(line.isWellFormed(), true, "Legal source text must stay well-formed");
    assert.equal(Buffer.from(line, "utf8").toString("utf8"), line, "UTF-8 roundtrip must not introduce replacement characters");
  }
}

const prefix = "a".repeat(79);
const crossing = `${prefix}😀z`;

test("legacy printer does not split the user summary pair", () => {
  const h = harness();
  h.api.printSessionSummaries([summary(crossing, "answer")]);
  assertLines(h.lines, expectedLines(prefix, "answer"));
});

test("legacy printer does not split the assistant summary pair", () => {
  const h = harness();
  h.api.printSessionSummaries([summary("question", crossing)]);
  assertLines(h.lines, expectedLines("question", prefix));
});

test("catalog page protects both summaries without changing branch status or cursor", () => {
  const value = summary(crossing, crossing);
  value.lastTurnStatus = { type: "turn_status", status: "completed", stopReason: "done", steps: 1 };
  const page = pageOf(value);
  page.items[0]!.parentSessionId = "parent";
  page.items[0]!.branchPoint = { kind: "user_message", index: 3 };
  page.nextCursor = "next-token";
  const before = JSON.stringify(page);
  const h = harness();
  h.api.printSessionCatalogPage(page);
  assertLines(h.lines, [
    `${expectedLines(prefix, prefix)[0]}\tcompleted`, `  user: ${prefix}`, `  biny: ${prefix}`,
    "  branch: parent @ user_message:3", "next-cursor: next-token"
  ]);
  assert.equal(JSON.stringify(page), before);
});

test("catalog page preserves message branch metadata while clipping both summaries", () => {
  for (const role of ["user", "assistant"] as const) {
    const page = pageOf(summary(crossing, crossing));
    page.items[0]!.parentSessionId = "parent";
    page.items[0]!.branchPoint = { kind: "message", index: 3, messageId: "selected-message", role };
    const before = JSON.stringify(page);
    const h = harness();
    h.api.printSessionCatalogPage(page);
    assertLines(h.lines, [...expectedLines(prefix, prefix), "  branch: parent @ message:3"]);
    assert.equal(JSON.stringify(page), before);
  }
});

test("clipping boundary is computed after existing whitespace folding", () => {
  const input = `${"a".repeat(78)}\n\t  😀z`;
  const h = harness();
  h.api.printSessionSummaries([summary(input, input)]);
  assertLines(h.lines, expectedLines(`${"a".repeat(78)} `, `${"a".repeat(78)} `));
});

test("non-JSON sessions command reaches safe clipping with unchanged query options", async () => {
  const page = pageOf(summary(crossing, crossing));
  const before = JSON.stringify(page);
  const h = harness(page);
  await h.api.sessionsCommand("inert-workspace", { limit: 7, cursor: "cursor", parent: "parent" });
  assert.deepEqual(h.calls, [
    { name: "ensure", root: "inert-workspace" },
    { name: "query", root: "inert-workspace", options: { limit: 7, cursor: "cursor", parentSessionId: "parent" } }
  ]);
  assertLines(h.lines, expectedLines(prefix, prefix));
  assert.equal(JSON.stringify(page), before);
});

test("pair exactly fitting 80 UTF-16 units is retained", () => {
  const fitting = `${"a".repeat(78)}😀`;
  const h = harness();
  h.api.printSessionSummaries([summary(fitting, `${fitting}tail`)]);
  assertLines(h.lines, expectedLines(fitting, fitting));
});

test("80-unit ASCII boundary and overlong ASCII behavior stay identical", () => {
  const ascii = "a".repeat(80);
  const h = harness();
  h.api.printSessionSummaries([summary(ascii, `${ascii}tail`)]);
  assertLines(h.lines, expectedLines(ascii, ascii));
});

test("short mixed Unicode and CJK are unchanged", () => {
  const h = harness();
  h.api.printSessionSummaries([summary("你好😀abc", "中文🌍答复")]);
  assertLines(h.lines, expectedLines("你好😀abc", "中文🌍答复"));
});

test("leading trailing and interior whitespace retain their original folding", () => {
  const h = harness();
  h.api.printSessionSummaries([summary("\n hi\tthere \n", "\t answer\nnow\t")]);
  assertLines(h.lines, expectedLines(" hi there ", " answer now "));
});

test("empty content keeps separate placeholders", () => {
  const h = harness();
  h.api.printSessionSummaries([summary("", "")]);
  assertLines(h.lines, expectedLines("(no user_message)", "(no assistant_message)"));
});

test("whitespace-only content stays one space rather than becoming a placeholder", () => {
  const h = harness();
  h.api.printSessionSummaries([summary("\n\t ", " \r\n")]);
  assertLines(h.lines, expectedLines(" ", " "));
});

test("empty catalog and legacy lists keep their notices", () => {
  const h = harness();
  h.api.printSessionCatalogPage({ revision: "empty", items: [], nextCursor: "ignored" });
  h.api.printSessionSummaries([]);
  assertLines(h.lines, ["No sessions found.", "No sessions found."]);
});

test("revision-changed non-JSON command retains its notice and default query", async () => {
  const h = harness({ ...pageOf(summary(crossing, crossing)), revisionChanged: true });
  await h.api.sessionsCommand("inert-workspace");
  assert.deepEqual(h.calls, [
    { name: "ensure", root: "inert-workspace" },
    { name: "query", root: "inert-workspace", options: { limit: undefined, cursor: undefined, parentSessionId: undefined } }
  ]);
  assertLines(h.lines, ["Session list changed; request the first page again."]);
});

test("JSON command bypasses clipping and revision notice and retains full content", async () => {
  const page = { ...pageOf(summary(crossing, crossing)), revisionChanged: true, nextCursor: "next" };
  const before = JSON.stringify(page);
  const h = harness(page);
  await h.api.sessionsCommand("inert-workspace", { json: true });
  assertLines(h.lines, [before]);
  assert.equal(JSON.stringify(page), before);
  assert.equal(h.calls.length, 2);
});

test("catalog and legacy preserve row order and optional branch suppression", () => {
  const page = pageOf(summary("first", "one"));
  page.items[0]!.parentSessionId = "parent-without-point";
  page.items.push(pageOf(summary("second", "two")).items[0]!);
  const h = harness();
  h.api.printSessionCatalogPage(page);
  h.api.printSessionSummaries(page.items.map(item => item.summary));
  const expected = [...expectedLines("first", "one"), ...expectedLines("second", "two")];
  assertLines(h.lines, [...expected, ...expected]);
});

test("relative-time display retains just-now minute and day branches", () => {
  const h = harness();
  for (const [updatedAt, label] of [
    ["2026-10-24T11:59:59.000Z", "just now"],
    ["2026-10-24T11:58:00.000Z", "2m ago"],
    ["2026-10-22T12:00:00.000Z", "2d ago"]
  ]) {
    const value = summary("user", "assistant");
    value.updatedAt = updatedAt!;
    h.api.printSessionSummaries([value]);
    assert.equal(h.lines.at(-3), `synthetic.jsonl\t2026-10-24T10:00:00.000Z\t${label}\t2 events`);
  }
});
