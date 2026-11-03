import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolOptimizationSnapshot, ToolOptimizationStore } from "../src/session/toolOptimizationStore.js";

test("durable statistics skip unchanged transcript content and reconcile appended, replaced, deleted and corrupt sessions", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-optimization-index-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const project = { id: "project", path: root };
  const scope = { days: "all" as const, projects: [project] };
  const database = path.join(root, "statistics.sqlite");
  const recorders: SessionRecorder[] = [];
  let store: ToolOptimizationStore | undefined;
  try {
    await ensureAgentDirs(root);
    for (const id of ["first", "second"]) {
      const recorder = new SessionRecorder(root, id); recorders.push(recorder);
      recorder.record({ type: "tool_result", time: "2026-10-30T12:00:00Z", tool: "Bash", toolCallId: id, result: {},
        optimization: { id, kind: "rtk", estimator: "rtk", beforeTokens: 100, afterTokens: 40, savedTokens: 60, toolCalls: 1, command: "git status" } });
      await recorder.close();
    }
    const reads: string[] = [];
    const original = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".jsonl")) {
        const read = handle.read.bind(handle);
        handle.read = ((...parameters: Parameters<typeof handle.read>) => {
          reads.push(String(args[0]));
          return read(...parameters);
        }) as typeof handle.read;
      }
      return handle;
    });
    assert.equal(readToolOptimizationSnapshot(database, scope), undefined);
    store = new ToolOptimizationStore(database);
    assert.equal((await store.refresh(scope)).rtk.savedTokens, 120);
    assert.equal(new Set(reads).size, 2);
    store.close(); store = new ToolOptimizationStore(database);
    reads.length = 0;
    assert.equal(readToolOptimizationSnapshot(database, scope)?.rtk.savedTokens, 120);
    assert.equal(readToolOptimizationSnapshot(database, { ...scope, sessionId: "first" }), undefined);
    assert.equal((await store.refresh(scope)).rtk.savedTokens, 120);
    assert.deepEqual(reads, [], "index reuse survives a new store instance");
    const receipt = { type: "tool_result", time: "2026-10-30T13:00:00Z", tool: "Bash", toolCallId: "added", result: {},
      optimization: { id: "added", kind: "rtk", estimator: "rtk", beforeTokens: 100, afterTokens: 120, savedTokens: -20, toolCalls: 1 } };
    await fs.appendFile(recorders[0]!.filePath, JSON.stringify(receipt) + "\n");
    assert.equal(readToolOptimizationSnapshot(database, scope)?.rtk.savedTokens, 120, "cached overview remains available before reconciliation");
    assert.equal((await store.refresh(scope)).rtk.savedTokens, 100);
    assert.deepEqual([...new Set(reads)], [recorders[0]!.filePath], "only appended session content is read");
    reads.length = 0;
    const replacement = recorders[0]!.filePath + ".replacement";
    await fs.writeFile(replacement, JSON.stringify(receipt) + "\n");
    await fs.rename(replacement, recorders[0]!.filePath);
    assert.equal((await store.refresh(scope)).rtk.savedTokens, 40);
    await fs.unlink(recorders[1]!.filePath);
    assert.equal((await store.refresh(scope)).rtk.savedTokens, -20);
    await fs.writeFile(recorders[0]!.filePath, "{broken}\n");
    const partial = await store.refresh(scope);
    assert.equal(partial.incompleteSessions, 1);
    assert.equal(partial.rtk.runs, 0, "invalidated rows cannot contribute stale receipts");
    await fs.writeFile(recorders[0]!.filePath, JSON.stringify(receipt) + "\n");
    assert.equal((await store.refresh(scope)).incompleteSessions, 0);
    assert.equal((await store.refresh({ ...scope, projects: [{ ...project, missing: true }] })).incompleteSessions, 1);
  } finally {
    store?.close();
    for (const recorder of recorders) await recorder.close();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persisted overview read performs no session I/O with a large history", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-optimization-cost-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let store: ToolOptimizationStore | undefined;
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, "seed");
    recorder.record({ type: "user_message", content: "fixture" });
    await recorder.close();
    const directory = path.dirname(recorder.filePath);
    const padding = JSON.stringify({ type: "user_message", content: "history ".repeat(4096) });
    for (let i = 0; i < 120; i++) {
      const receipt = JSON.stringify({ type: "tool_result", tool: "Bash", time: "2026-10-30T12:00:00Z", result: {},
        optimization: { id: `run-${i}`, kind: "ptc", estimator: "utf8/3", beforeTokens: 100, afterTokens: 10, savedTokens: 90, toolCalls: 2 } });
      await fs.writeFile(path.join(directory, `history-${i}.jsonl`), `${padding}\n`.repeat(20) + receipt + "\n");
    }
    const file = path.join(root, "statistics.sqlite");
    const scope = { days: "all" as const, projects: [{ id: "large", path: root }] };
    store = new ToolOptimizationStore(file);
    const started = performance.now();
    assert.equal((await store.refresh(scope)).ptc.savedTokens, 10_800);
    const coldMs = performance.now() - started;
    store.close(); store = undefined;
    const open = context.mock.method(fs, "open", () => { throw new Error("snapshot must not open session files"); });
    const readdir = context.mock.method(fs, "readdir", () => { throw new Error("snapshot must not enumerate sessions"); });
    const cachedAt = performance.now();
    assert.equal(readToolOptimizationSnapshot(file, scope)?.ptc.savedTokens, 10_800);
    const cachedMs = performance.now() - cachedAt;
    assert.equal(open.mock.callCount(), 0);
    assert.equal(readdir.mock.callCount(), 0);
    context.diagnostic(`Synthetic 120-session history: initial index ${coldMs.toFixed(1)}ms; persisted overview ${cachedMs.toFixed(1)}ms`);
  } finally {
    store?.close();
    context.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
