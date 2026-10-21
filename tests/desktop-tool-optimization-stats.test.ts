import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopProject } from "../src/desktop/protocol.js";
import { listSessionCatalog } from "../src/session/catalog.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { maxSessionEventLineBytes, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { summarizeToolOptimizations, type ToolOptimization } from "../src/session/toolOptimization.js";

const receipt = (id: string, savedTokens = 70): ToolOptimization => ({
  id, kind: "rtk", estimator: "rtk", beforeTokens: 100, afterTokens: 100 - savedTokens, savedTokens, toolCalls: 1
});
const day = (offset = 0): string => {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + offset);
  return value.toISOString();
};
const jsonl = (events: readonly unknown[]): string => events.map(event => JSON.stringify(event)).join("\n") + "\n";
function events(id: string, time = day(), toolCallId = `call-${id}`): Array<Record<string, unknown>> {
  return [
    { type: "user_message", content: "Synthetic statistics fixture", time },
    { type: "tool_call", tool: "Bash", toolCallId, args: { command: `git status ${id}` }, time },
    { type: "tool_result", tool: "Bash", toolCallId, result: { stdout: `compressed ${id}` }, optimization: receipt(id), time }
  ];
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-stats-receipts-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const network: string[] = [];
  t.after(async () => {
    try { await rm(root, { recursive: true, force: true }); }
    finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
    }
    assert.deepEqual(network, [], "Statistics never invoke an external service");
  });
  t.mock.method(globalThis, "fetch", () => { network.push("fetch"); throw new Error("Unexpected network request"); });
  t.mock.method(Socket.prototype, "connect", () => { network.push("socket"); throw new Error("Unexpected socket connection"); });
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  const config = new Proxy({} as ConstructorParameters<typeof DesktopProjectService>[2], {
    get() { throw new Error("Statistics must not load model configuration"); }
  });
  const service = new DesktopProjectService(state, storage, config);
  async function project(id: string, missing = false): Promise<DesktopProject> {
    const workspace = path.join(root, id);
    await mkdir(workspace);
    if (!missing) await ensureAgentDirs(workspace);
    const value: DesktopProject = { id, name: id, path: workspace, addedAt: day(), lastOpenedAt: day(), missing, dirty: false, pinned: false };
    await state.upsertProject(value);
    return value;
  }
  async function session(project: DesktopProject, id: string, contents: string): Promise<string> {
    return createSessionFile(project.path, id, Buffer.from(contents));
  }
  return { root, state, service, project, session };
}

test("statistics mark malformed histories as incomplete while healthy recovery stays available", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  await h.session(p, "healthy", jsonl(events("healthy")));
  await h.session(p, "bad-json", jsonl(events("bad-json")) + '{"type":\n');
  const malformedReceipt = events("bad-schema");
  malformedReceipt[2]!.optimization = { ...receipt("bad-schema"), savedTokens: 999 };
  await h.session(p, "bad-schema", jsonl(malformedReceipt));
  assert.deepEqual((await listSessionCatalog(p.path)).map(item => item.id), ["healthy"], "Recovery catalog intentionally excludes unreadable sessions");
  await assert.rejects(readStoredSessionEvents(p.path, "bad-json"), /Invalid JSONL/);
  await assert.rejects(readStoredSessionEvents(p.path, "bad-schema"), /Invalid session event/);
  const stats = await h.service.toolOptimizationStats("all");
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["healthy"]);
  assert.equal(summarizeToolOptimizations(stats.entries).savedTokens, 70);
  assert.equal(stats.incompleteSessions, 2, "Omitted unreadable histories must not look like complete statistics");
});

test("statistics count valid receipt-only histories and ignore empty histories", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  await h.session(p, "receipt-only", jsonl(events("receipt-only").slice(1)));
  await h.session(p, "empty", "");
  assert.deepEqual(await listSessionCatalog(p.path), []);
  const stats = await h.service.toolOptimizationStats("all");
  assert.equal(stats.incompleteSessions, 0);
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["receipt-only"]);
});

test("statistics expose rejected file and line budgets without trusting partial receipts", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  await h.session(p, "healthy", jsonl(events("healthy")));
  const oversized = await h.session(p, "oversized", jsonl(events("oversized")));
  await truncate(oversized, maxSessionFileBytes + 1);
  await h.session(p, "long-line", jsonl(events("long-line")) + "x".repeat(maxSessionEventLineBytes + 1) + "\n");
  const stats = await h.service.toolOptimizationStats("all");
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["healthy"]);
  assert.equal(stats.incompleteSessions, 2);
});

test("event-count admission includes the exact limit and rejects one more event", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  const rows = events("bounded");
  const filler = { type: "assistant_message", content: "synthetic", time: day() };
  const file = await h.session(p, "bounded", jsonl(rows) + jsonl([filler]).repeat(maxSessionEvents - rows.length));
  assert.equal((await h.service.toolOptimizationStats("all")).entries.length, 1);
  await writeFile(file, jsonl(rows) + jsonl([filler]).repeat(maxSessionEvents - rows.length + 1));
  const stats = await h.service.toolOptimizationStats("all");
  assert.deepEqual(stats.entries, []);
  assert.equal(stats.incompleteSessions, 1);
});

test("interrupted final fragments retain committed receipts but invalid timestamps are incomplete", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  await h.session(p, "partial-tail", jsonl(events("partial-tail")) + '{"type":');
  await h.session(p, "invalid-time", jsonl(events("invalid-time", "not-a-date")));
  const stats = await h.service.toolOptimizationStats("all");
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["partial-tail"]);
  assert.equal(stats.incompleteSessions, 1);
});

test("all-time statistics enumerate beyond catalog page sizes and retain exact detail origins", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  for (let index = 0; index < 55; index++) await h.session(p, `session-${index}`, jsonl(events(`operation-${index}`)));
  const stats = await h.service.toolOptimizationStats("all");
  assert.equal(stats.incompleteSessions, 0);
  assert.equal(stats.entries.length, 55);
  assert.equal(summarizeToolOptimizations(stats.entries).savedTokens, 55 * 70);
  const last = stats.entries.find(entry => entry.optimization.id === "operation-54")!;
  assert.deepEqual(last.origin, { projectId: p.id, sessionId: "session-54", toolCallId: "call-operation-54" });
  assert.equal(last.optimization.originalCommand, "git status operation-54");
  const detail = await h.service.toolOptimizationDetail(last.origin!.projectId, last.origin!.sessionId, last.origin!.toolCallId);
  assert.deepEqual(detail.events.map(event => event.type), ["tool_call", "tool_result"]);
  assert.deepEqual(detail.events[0]!.type === "tool_call" && detail.events[0].args, { command: "git status operation-54" });
  assert.equal(detail.events[1]!.type === "tool_result" && detail.events[1].optimization?.id, "operation-54");
});

test("replayed and cross-project receipts deduplicate by operation, not by tool-call ID", async t => {
  const h = await fixture(t);
  const a = await h.project("a"), b = await h.project("b");
  const shared = events("shared", day(), "same-call");
  await h.session(a, "source", jsonl(shared));
  await h.session(a, "fork", jsonl(shared));
  await h.session(b, "imported", jsonl(shared));
  await h.session(b, "distinct", jsonl(events("distinct", day(), "same-call")));
  const stats = await h.service.toolOptimizationStats("all");
  assert.equal(stats.incompleteSessions, 0);
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id).sort(), ["distinct", "shared"]);
  assert.equal(summarizeToolOptimizations(stats.entries).savedTokens, 140);
  for (const entry of stats.entries) {
    const origin = entry.origin!;
    const detail = await h.service.toolOptimizationDetail(origin.projectId, origin.sessionId, origin.toolCallId);
    assert.equal(detail.events.some(event => event.type === "tool_result" && event.optimization?.id === entry.optimization.id), true);
  }
});

test("project and session scopes exclude unrelated damage and range admission precedes deduplication", async t => {
  const h = await fixture(t);
  const a = await h.project("a"), b = await h.project("b");
  await h.session(a, "selected", jsonl([...events("shared", day(-2)), ...events("shared", day())]));
  await h.session(a, "unrelated", '{"type":\n');
  await h.session(b, "other", jsonl(events("other")));
  const selected = await h.service.toolOptimizationStats(1, a.id, "selected");
  assert.equal(selected.incompleteSessions, 0);
  assert.equal(selected.entries.length, 1);
  assert.equal(selected.entries[0]!.time, day());
  assert.deepEqual(await h.service.toolOptimizationStats("all", a.id, "missing-session"), { entries: [], incompleteSessions: 0 });
  const scoped = await h.service.toolOptimizationStats("all", a.id);
  assert.deepEqual(scoped.entries.map(entry => entry.optimization.id), ["shared"]);
  assert.equal(scoped.incompleteSessions, 1);
});

test("receipt range filtering does not use an unrelated final event timestamp as an upper bound", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  await h.session(p, "out-of-order", jsonl([...events("recent"), { type: "assistant_message", content: "imported older timestamp", time: day(-10) }]));
  const stats = await h.service.toolOptimizationStats(1);
  assert.equal(stats.incompleteSessions, 0);
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["recent"]);
});

test("refresh observes append, rewrite, replacement, removal and restored files", async t => {
  const h = await fixture(t);
  const p = await h.project("project");
  const file = await h.session(p, "changing", jsonl(events("first")));
  const ids = async () => (await h.service.toolOptimizationStats("all")).entries.map(entry => entry.optimization.id).sort();
  assert.deepEqual(await ids(), ["first"]);
  await writeFile(file, jsonl([...events("first"), ...events("second")]));
  assert.deepEqual(await ids(), ["first", "second"]);
  await writeFile(file, jsonl(events("rewritten")));
  assert.deepEqual(await ids(), ["rewritten"]);
  const replacement = path.join(h.root, "replacement.jsonl");
  await writeFile(replacement, jsonl(events("replacement")), { mode: 0o600 });
  await rename(replacement, file);
  assert.deepEqual(await ids(), ["replacement"]);
  await rm(file);
  assert.deepEqual(await ids(), []);
  await assert.rejects(h.service.toolOptimizationDetail(p.id, "changing", "call-replacement"));
  await h.session(p, "changing", jsonl(events("restored")));
  assert.deepEqual(await ids(), ["restored"]);
});

test("missing projects are counted without preventing healthy-project statistics", async t => {
  const h = await fixture(t);
  const p = await h.project("healthy");
  await h.project("missing", true);
  await h.session(p, "healthy", jsonl(events("healthy")));
  const stats = await h.service.toolOptimizationStats("all");
  assert.deepEqual(stats.entries.map(entry => entry.optimization.id), ["healthy"]);
  assert.equal(stats.incompleteSessions, 1);
});
