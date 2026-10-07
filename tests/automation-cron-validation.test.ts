import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readAutomationCreateInput } from "../src/runtime/host/validation.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";

await test("cron creation rejects malformed fields instead of saving a different active schedule", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2035-06-12T08:07:00.000Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cron-validation-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const previousTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const store = await AutomationStore.open(root, authority);
  try {
    const create = (cron: string) => store.create(readAutomationCreateInput({
      name: "Synthetic schedule", triggerType: "cron", schedule: { cron },
      executionTemplate: { prompt: "Synthetic validation only; do not execute" }
    }));
    for (const cron of [
      "0 9-24 * * *", "0,60 * * * *", "0 9 0-31 * *", "0 9 * 1-13 *", "0 9 * * 1-7",
      "*/15/2 * * * *", "0 9 * * 1-5-7", "5, * * * *", "0,word * * * *", "0,5-1 * * * *",
      "0,*/0 * * * *", "0,*/1.5 * * * *", "0,*/9007199254740992 * * * *"
    ]) {
      // Existing due-time coverage only used valid cron fields; malformed members were ignored or truncated.
      await t.test(`${cron} fails before persisting any definition or creation event`, () => {
        const before = { records: store.list(), events: authority.readEvents() };
        assert.throws(() => create(cron), /Invalid cron (minute|hour|day|month|weekday) field:/u);
        assert.deepEqual({ records: store.list(), events: authority.readEvents() }, before);
      });
    }
    for (const [cron, expected] of [
      ["* * * * *", "2035-06-12T08:08:00.000Z"],
      ["*/15 * * * *", "2035-06-12T08:15:00.000Z"],
      ["5-50/15 8-17 * * 1-5", "2035-06-12T08:20:00.000Z"],
      ["05,20 8,12 * * *", "2035-06-12T08:20:00.000Z"],
      ["0 9 1-31 1-12 0-6", "2035-06-12T09:00:00.000Z"]
    ] as const) {
      await t.test(`${cron} retains its existing next occurrence`, () => {
        const record = create(cron);
        assert.equal(record.nextFireAt, expected);
        assert.equal(record.schedule.cron, cron);
        assert.equal(record.status, "active");
        assert.deepEqual(store.get(record.automationId), record);
      });
    }
  } finally {
    store.close();
    authority.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    await rm(root, { recursive: true, force: true });
  }
});

await test("automation create surfaces invalid cron input through the CLI without persisting a schedule", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cron-cli-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const store = await AutomationStore.open(root, authority);
  const paths = runtimeHostPaths(root);
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  const preload = path.join(root, "automation-create-transport.mjs");
  try {
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    await writeFile(paths.registrationPath, JSON.stringify({
      ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
      persistenceRoot: root, hostEpoch: "cron-cli-fixture", token: "synthetic-cron-token",
      pid: process.pid, createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    // Preserve CLI parsing, client serialization, Host validation and SQLite; replace the transport and admission boundary.
    await writeFile(preload, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { RuntimeHostClient } from ${source("src/runtime/host/client.ts")};
import { RuntimeEventAuthority } from ${source("src/runtime/RuntimeAuthority.ts")};
import { AutomationStore } from ${source("src/runtime/AutomationScheduler.ts")};
import { readAutomationCreateInput } from ${source("src/runtime/host/validation.ts")};
const authority = await RuntimeEventAuthority.open(process.cwd(), { backfillLegacySessions: false });
const store = await AutomationStore.open(process.cwd(), authority);
let requests = 0;
let closed = 0;
mock.method(childProcess, "spawn", () => { throw new Error("Unexpected Runtime Host start."); });
syncBuiltinESMExports();
mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request."); });
mock.method(RuntimeHostClient, "connect", async () => ({
  automationCreate: RuntimeHostClient.prototype.automationCreate,
  async request(operation, payload) {
    requests++;
    assert.equal(operation, "automation.create");
    const result = store.create(readAutomationCreateInput(JSON.parse(JSON.stringify(payload))));
    return { accepted: true, result: JSON.parse(JSON.stringify(result)) };
  },
  async close() { closed++; store.close(); authority.close(); }
}));
process.once("exit", () => {
  assert.equal(requests, 1);
  assert.equal(closed, 1);
});
`);
    const run = (cron: string, json: boolean) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href,
      path.resolve("src/cli/index.ts"), "automation", "create", "office-hours",
      "--trigger", "cron", "--cron", cron, "--prompt", "Synthetic reminder; do not execute",
      ...(json ? ["--json"] : [])
    ], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000 });
    for (const json of [true, false]) {
      await t.test(`invalid hour range in ${json ? "JSON" : "text"} mode exits 1 with no stdout`, () => {
        const before = { records: store.list(), events: authority.readEvents() };
        const result = run("0 9-24 * * *", json);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, `stdout: ${result.stdout}; stderr: ${result.stderr}`);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "Invalid cron hour field: 9-24.\n");
        assert.deepEqual({ records: store.list(), events: authority.readEvents() }, before);
      });
      await t.test(`valid office-hours schedule in ${json ? "JSON" : "text"} mode succeeds and is saved`, () => {
        const before = store.list().length;
        const result = run("*/15 9-17 * * 1-5", json);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        const record = JSON.parse(result.stdout) as { automationId: string; status: string; schedule: { cron: string } };
        assert.equal(record.status, "active");
        assert.equal(record.schedule.cron, "*/15 9-17 * * 1-5");
        assert.deepEqual(JSON.parse(JSON.stringify(store.get(record.automationId))), record);
        assert.equal(store.list().length, before + 1);
        assert.equal(result.stdout, `${JSON.stringify(record, null, json ? undefined : 2)}\n`);
      });
    }
  } finally {
    store.close();
    authority.close();
    await rm(paths.registrationPath, { force: true });
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
