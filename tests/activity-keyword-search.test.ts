/** Keyword searches treat SQL LIKE metacharacters as literal OCR text. No sockets or capture host are used. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";

const fixtures = [
  { id: "underscore", text: "found foo_bar here" },
  { id: "underscore-decoy", text: "found fooXbar here" },
  { id: "backslash", text: "found path\\config here" },
  { id: "backslash-decoy", text: "found pathconfig here" },
  { id: "trailing-backslash", text: "found trailing\\ here" },
  { id: "percent", text: "100% complete" },
  { id: "percent-decoy", text: "1000 complete" },
  { id: "mixed", text: "found \\%_ here" },
  { id: "mixed-decoy", text: "found \\Xz here" },
  { id: "cjk", text: "中文检索验证" }
];

const cases = [
  { query: "foo_bar", ids: ["underscore"] },
  { query: "path\\config", ids: ["backslash"] },
  { query: "trailing\\", ids: ["trailing-backslash"] },
  { query: "100%", ids: ["percent"] },
  { query: "\\%_", ids: ["mixed"] },
  { query: "FOO_BAR", ids: ["underscore"] },
  { query: "  foo_bar  ", ids: ["underscore"] },
  { query: "中文检索", ids: ["cjk"] },
  { query: "   ", ids: [] }
];

function fixtureDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  // Isolate the query against real SQLite from on-disk schema migration and capture setup.
  database.exec(`
    CREATE TABLE activity_generation (id INTEGER PRIMARY KEY, revision TEXT NOT NULL);
    INSERT INTO activity_generation VALUES (1, 'fixture');
    CREATE TABLE activity_ocr_frames (
      id TEXT PRIMARY KEY, session_id TEXT, snapshot_id TEXT, created_at INTEGER,
      occurred_at TEXT, application TEXT, window_title TEXT, text TEXT
    );
  `);
  const insert = database.prepare("INSERT INTO activity_ocr_frames VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [index, fixture] of fixtures.entries()) {
    insert.run(fixture.id, "session", `snapshot-${fixture.id}`, index,
      "2026-10-04T00:00:00.000Z", "Editor", null, fixture.text);
  }
  return database;
}

test("ActivityStore keyword search matches literal substrings", async (t) => {
  const database = fixtureDatabase();
  const store = new ActivityStore();
  Object.assign(store, { database });
  try {
    for (const { query, ids } of cases) {
      await t.test(JSON.stringify(query), () => {
        assert.deepEqual(store.search(query).map((row) => row.id), ids);
      });
    }
    assert.deepEqual(store.search("%", 1).map((row) => row.id), ["mixed"],
      "literal matching must preserve newest-first ordering and the requested limit");
    assert.deepEqual(store.search("%", 2).map((row) => row.id), ["mixed", "percent"]);
  } finally {
    await store.close();
  }
});

test("Activity REST keyword routes preserve literal queries and response metadata", async (t) => {
  const database = fixtureDatabase();
  // Exercise the handler and production query without opening a listener or persistent store.
  t.mock.method(ActivityStore.prototype, "open", async function (this: ActivityStore) {
    Object.assign(this, { database });
  });
  t.mock.method(ActivityStore.prototype, "close", async () => undefined);
  try {
    for (const pathname of ["/api/activity-recorder/search", "/api/activity-recorder/search/keyword"]) {
      for (const { query, ids } of cases) {
        await t.test(`${pathname}: ${JSON.stringify(query)}`, async () => {
          const response = await handleActivityHttpRequest({
            method: "GET", pathname, searchParams: new URLSearchParams({ q: query, limit: "1" })
          }, { loadSettings: async () => defaultActivitySettings });
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { results: ids.map((id) => {
            const index = fixtures.findIndex((fixture) => fixture.id === id);
            return { id, sessionId: "session", snapshotId: `snapshot-${id}`,
              text: fixtures[index]!.text, createdAt: index };
          }) });
        });
      }
    }
  } finally {
    database.close();
  }
});
