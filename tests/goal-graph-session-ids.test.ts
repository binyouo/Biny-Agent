import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { test } from "node:test";
import { GoalGraphStore, type GraphStatus } from "../src/runtime/GoalGraphStore.js";
import type { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

// Read the production DDL as text; never open an Authority or execute migrations.
const authoritySource = readFileSync("src/runtime/RuntimeAuthority.ts", "utf8");
const schema = ["graphs", "graph_nodes"].map((name) => {
  const match = authoritySource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n          \\);`));
  assert.ok(match, `Missing ${name} schema`);
  return match[0];
}).join("\n");
const workspaceId = "workspace'_%";
const statuses: GraphStatus[] = ["draft", "running", "paused", "completed", "failed", "blocked", "cancelled"];
const sessions = ["owner", "other", "", " ", "Owner", "owner'_%", "owner'Xa", "missing"];

for (const populated of [false, true]) {
  await test(`supervised graph ID discovery stays scoped and read-only (${populated ? "history" : "empty"})`, async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    database.exec(schema);
    const access = new Set<string>();
    // Query-only adapter: fail on any Authority operation beyond the two read dependencies.
    const authority = new Proxy({ workspaceId, databaseHandle: () => database }, {
      get(target, key) {
        assert.ok(key === "workspaceId" || key === "databaseHandle", `Unexpected Authority access: ${String(key)}`);
        access.add(key);
        return Reflect.get(target, key);
      }
    }) as unknown as RuntimeEventAuthority;
    const graphs = await GoalGraphStore.open("", authority);
    try {
      if (populated) seed(database);
      database.exec("PRAGMA query_only = ON");
      const changes = database.prepare("SELECT total_changes() AS n").get()!.n;
      for (const transaction of [false, true]) {
        if (transaction) database.exec("BEGIN");
        assert.equal(database.isTransaction, transaction);
        for (const sessionId of sessions) {
          const old = observe(database, () => graphs.listGraphs()
            .filter((graph) => graph.mode === "supervised" && graph.supervisorSessionId === sessionId)
            .map((graph) => graph.graphId));
          assert.equal(database.isTransaction, transaction);
          const current = observe(database, () => graphs.listSupervisedGraphIds(sessionId));
          // Ties compare the current engine's observed sequence, not a portable tie-break contract.
          assert.deepEqual(current.ids, old.ids);
          const expected = !populated || sessionId === "missing" ? [] : sessionId === "owner"
            ? statuses.map((_, index) => `history-${index}`) : [`session-${sessions.indexOf(sessionId)}`];
          assert.deepEqual([...current.ids].sort(), expected.sort());
          assert.equal(current.sql.length, 1);
          assert.match(current.sql[0]!, /^SELECT graph_id FROM graphs\b/u);
          assert.equal(current.nodeRows, 0);
          assert.equal(current.jsonParses, 0);
          assert.equal(current.jsonBytes, 0);
          assert.equal(old.sql.length, populated ? 16 : 1);
          assert.equal(old.nodeRows, populated ? 15 : 0);
          assert.ok(!populated || old.jsonParses > 0);
          assert.equal(database.isTransaction, transaction, "discovery preserves the caller's transaction");
          assert.equal(database.prepare("SELECT total_changes() AS n").get()!.n, changes);
        }
        if (transaction) database.exec("ROLLBACK");
      }
      assert.deepEqual([...access].sort(), ["databaseHandle", "workspaceId"]);
    } finally {
      graphs.close();
      database.close();
    }
  });
}

function seed(database: DatabaseSync): void {
  const insertGraph = database.prepare("INSERT INTO graphs (graph_id, workspace_id, status, mode, supervisor_session_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertNode = database.prepare("INSERT INTO graph_nodes (node_id, graph_id, node_key, status, dependencies_json, intent_json) VALUES (?, ?, 'report', 'pending', '[]', ?)");
  function add(id: string, session: string | null, status: GraphStatus = "draft", workspace = workspaceId, mode = "supervised", day = 1): void {
    const created = `2026-01-0${day}T00:00:00.000Z`;
    insertGraph.run(id, workspace, status, mode, session, JSON.stringify({ objective: "Read synthetic facts" }), created, created);
    insertNode.run(`${id}-node`, id, JSON.stringify({ prompt: "Read synthetic facts", planBlock: { taskKey: "report", title: "Report", acceptance: ["State observed facts"], kind: "report" } }));
  }
  // Persisted query fixtures, not claims that every state is creatable through the writer API.
  statuses.forEach((status, index) => add(`history-${index}`, "owner", status, workspaceId, "supervised", 3 - index % 3));
  sessions.slice(1, -1).forEach((session, index) => add(`session-${index + 1}`, session));
  add("fixed", "owner", "draft", workspaceId, "fixed");
  add("null-session", null);
  for (const [index, workspace] of ["foreign", "Workspace'_%", "workspace'_% "].entries()) {
    add(`foreign-${index}`, "owner", "draft", workspace);
  }
}

function observe(database: DatabaseSync, read: () => string[]) {
  const sql: string[] = [];
  let nodeRows = 0, jsonParses = 0, jsonBytes = 0;
  const prepare = database.prepare, parse = JSON.parse;
  database.prepare = function (query: string) {
    sql.push(query);
    const statement = prepare.call(database, query), all = statement.all;
    statement.all = function (...args: Array<SQLInputValue | Record<string, SQLInputValue>>): Array<Record<string, SQLOutputValue>> {
      const rows: Array<Record<string, SQLOutputValue>> = Reflect.apply(all, statement, args);
      if (query.includes("FROM graph_nodes")) nodeRows += rows.length;
      return rows;
    };
    return statement;
  };
  JSON.parse = function (...args: Parameters<typeof parse>) {
    jsonParses++;
    jsonBytes += Buffer.byteLength(String(args[0]));
    return Reflect.apply(parse, JSON, args);
  };
  try {
    const ids = read();
    return { ids, sql, nodeRows, jsonParses, jsonBytes };
  } finally {
    database.prepare = prepare;
    JSON.parse = parse;
  }
}
