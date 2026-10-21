/** A fork's event bytes, reported source and inherited catalog must share one source. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import type { SessionCatalogRecord } from "../src/session/catalog.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-fork-identity-")));
const previousAgentRoot = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
// Load production modules only after isolating every persistence path.
const { createSessionFile, ensureAgentDirs, resolveSessionFile } = await import("../src/session/store.js");
const { readSessionCatalogRecord, writeSessionCatalogRecord } = await import("../src/session/catalog.js");
const { forkSession } = await import("../src/session/fork.js");
after(async () => {
  if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function sourceEvents(source: string): SessionEvent[] {
  const events: SessionEvent[] = [
    { type: "user_message", content: `${source} request`, messageId: `${source}-u1`, slotId: `${source}-u1` },
    { type: "assistant_message", content: `${source} answer`, messageId: `${source}-a1`, parentMessageId: `${source}-u1` },
    { type: "user_message", content: `${source} follow-up`, messageId: `${source}-u2`, parentMessageId: `${source}-a1` },
    { type: "tool_call", tool: "Read", args: { path: `${source}.txt` }, toolCallId: `${source}-call`, sequence: 1 },
    { type: "tool_result", tool: "Read", result: { content: `${source} body` }, toolCallId: `${source}-call`, sequence: 1 },
    { type: "assistant_message", content: `${source} done`, messageId: `${source}-a2`, parentMessageId: `${source}-u2` }
  ];
  return events.map((event, index) => ({
    ...event,
    runtime: { eventId: `${source}-event-${index}`, eventSeq: 41 + index,
      runId: `${source}-run`, turnId: `${source}-turn-${index < 2 ? 1 : 2}` }
  }));
}

function jsonl(events: SessionEvent[]): string {
  return `${events.map(event => JSON.stringify(event)).join("\n")}\n`;
}

function withoutRuntime(events: SessionEvent[]): Omit<SessionEvent, "runtime">[] {
  return events.map(({ runtime: _runtime, ...event }) => event);
}

for (const reference of [undefined, "latest", "source-a"] as const) {
  for (const advance of [true, false]) {
    for (const safeCut of [false, true]) {
      test(`fork identity: ${reference ?? "omitted"}, ${advance ? "changes" : "stable"}, ${safeCut ? "safe cut" : "full"}`, async (t) => {
        const workspace = path.join(root, `${reference ?? "omitted"}-${advance}-${safeCut}`);
        await fs.mkdir(workspace);
        await ensureAgentDirs(workspace);
        const aEvents = sourceEvents("A");
        const bEvents = sourceEvents("B");
        const aSource = jsonl(aEvents);
        const bSource = jsonl(bEvents);
        const appended = jsonl([{ type: "assistant_message", content: "B continues" }]);
        const aPath = await createSessionFile(workspace, "source-a", Buffer.from(aSource));
        const bPath = await createSessionFile(workspace, "source-b", Buffer.from(bSource));
        const now = "2020-01-01T00:00:00.000Z";
        const aCatalog: SessionCatalogRecord = {
          version: 1, sessionId: "source-a", parentSessionId: "ancestor-a", rootSessionId: "root-a",
          branchPoint: { kind: "event", index: 1 },
          personalization: { useMemories: false, contributeMemories: true }, isolation: "worktree",
          createdAt: now, updatedAt: now
        };
        const bCatalog: SessionCatalogRecord = {
          version: 1, sessionId: "source-b", parentSessionId: "ancestor-b", rootSessionId: "root-b",
          branchPoint: { kind: "event", index: 2 },
          personalization: { useMemories: true, contributeMemories: false }, isolation: "shared",
          createdAt: now, updatedAt: now
        };
        await writeSessionCatalogRecord(workspace, aCatalog);
        await writeSessionCatalogRecord(workspace, bCatalog);
        const early = new Date(now);
        const initialLatest = new Date("2020-01-02T00:00:00.000Z");
        const nextLatest = new Date("2020-01-03T00:00:00.000Z");
        await fs.utimes(bPath, early, early);
        await fs.utimes(aPath, initialLatest, initialLatest);
        assert.equal(await resolveSessionFile(workspace, "latest"), aPath);
        const aBefore = await fs.stat(aPath);
        const bBefore = await fs.stat(bPath);
        const open = fs.open.bind(fs);
        const firstHandles = new Set<string>();
        const closed = new Set<string>();
        let promotions = 0;
        let forked: Awaited<ReturnType<typeof forkSession>>;
        try {
          t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
            const handle = await open(...args);
            const file = args[0];
            if (typeof file !== "string" || (file !== aPath && file !== bPath) || firstHandles.has(file)) return handle;
            firstHandles.add(file);
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => {
              await close();
              closed.add(file);
              // latest's two discovery handles have both completed their real stat/binding
              // checks before either final close can promote B. Their saved stats still pick A.
              // An explicit ID only opens A; its control advances B after that first close.
              const complete = reference === "source-a" ? closed.has(aPath) : closed.size === 2;
              if (!advance || !complete || promotions !== 0) return;
              promotions += 1;
              await fs.appendFile(bPath, appended);
              await fs.utimes(bPath, nextLatest, nextLatest);
            });
            return handle;
          });
          forked = await forkSession(workspace, reference, safeCut ? { upToEvent: 4 } : {});
        } finally {
          t.mock.restoreAll();
        }

        const events = (await fs.readFile(forked.filePath, "utf8")).trim().split("\n")
          .map(line => JSON.parse(line) as SessionEvent);
        const catalog = await readSessionCatalogRecord(workspace, forked.sessionId);
        const kept = aEvents.slice(0, safeCut ? 3 : aEvents.length);
        // First business assertion aggregates content AND provenance: baseline pairs B's
        // body with A's reported parent/root/config. Equal event counts cannot hide it.
        assert.deepEqual({
          body: withoutRuntime(events), sourceSessionId: forked.sourceSessionId,
          parentSessionId: catalog?.parentSessionId, rootSessionId: catalog?.rootSessionId,
          personalization: catalog?.personalization, isolation: catalog?.isolation
        }, {
          body: withoutRuntime(kept), sourceSessionId: "source-a",
          parentSessionId: "source-a", rootSessionId: "root-a",
          personalization: aCatalog.personalization, isolation: aCatalog.isolation
        }, "fork body and all source identity/configuration must belong to A");
        assert.equal(promotions, advance ? 1 : 0);
        assert.deepEqual([...closed].sort(), reference === "source-a" ? [aPath] : [aPath, bPath].sort());
        assert.equal(forked.events, kept.length);
        assert.notEqual(forked.sessionId, "source-a");
        assert.notEqual(forked.sessionId, "source-b");
        assert.equal(path.basename(forked.filePath), `${forked.sessionId}.jsonl`);
        assert.equal(catalog?.sessionId, forked.sessionId);
        assert.deepEqual(catalog?.branchPoint, { kind: "event", index: kept.length });
        assert.deepEqual(events.map(event => event.runtime?.eventSeq), kept.map((_event, index) => index + 1));
        const oldIds = new Set([...aEvents, ...bEvents].flatMap(event =>
          [event.runtime!.eventId, event.runtime!.runId, event.runtime!.turnId]));
        const newEventIds = events.map(event => event.runtime!.eventId);
        assert.equal(new Set(newEventIds).size, kept.length);
        for (const event of events) {
          for (const value of [event.runtime?.eventId, event.runtime?.runId, event.runtime?.turnId]) {
            assert.ok(value && !oldIds.has(value), "fork runtime IDs must be fresh");
          }
        }
        assert.equal(new Set(events.map(event => event.runtime?.runId)).size, 1);
        for (let i = 0; i < kept.length; i++) {
          for (let j = 0; j < kept.length; j++) {
            assert.equal(events[i]!.runtime?.turnId === events[j]!.runtime?.turnId,
              kept[i]!.runtime?.turnId === kept[j]!.runtime?.turnId, "preserve turn grouping");
          }
        }
        assert.equal(await fs.readFile(aPath, "utf8"), aSource);
        assert.equal(await fs.readFile(bPath, "utf8"), bSource + (advance ? appended : ""));
        const aAfter = await fs.stat(aPath);
        const bAfter = await fs.stat(bPath);
        assert.deepEqual([aAfter.dev, aAfter.ino, aAfter.mode, aAfter.mtimeMs],
          [aBefore.dev, aBefore.ino, aBefore.mode, aBefore.mtimeMs]);
        assert.deepEqual([bAfter.dev, bAfter.ino, bAfter.mode], [bBefore.dev, bBefore.ino, bBefore.mode]);
        assert.equal(bAfter.mtimeMs, advance ? nextLatest.getTime() : bBefore.mtimeMs);
        assert.deepEqual(await readSessionCatalogRecord(workspace, "source-a"), aCatalog);
        assert.deepEqual(await readSessionCatalogRecord(workspace, "source-b"), bCatalog);
        // Exclude the newly created fork when confirming the physical latest promotion.
        await fs.utimes(forked.filePath, early, early);
        assert.equal(await resolveSessionFile(workspace, "latest"), advance ? bPath : aPath);
      });
    }
  }
}
