import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { taskListCommand, taskCreateCommand } from "../src/cli/commands/runtimeManagement.js";
import { createReplayFixture } from "./helpers/host-replay-backpressure-fixture.js";

test("a one-shot CLI query does not replay unrelated session history; observers still synchronize", async context => {
  const fixture = await createReplayFixture(context);
  // The actual CLI connects with the process environment rather than an override.
  fixture.registration.configRoot = fixture.registration.agentRoot;
  const host = await fixture.start(true);
  const snapshot = host.runtime.getSnapshot();
  for (let index = 0; index < 120; index++) host.internals.publish({ snapshot: { ...snapshot, info: { ...snapshot.info, sessionId: "unrelated-session" } } });
  const clients: RuntimeHostClient[] = [];
  const received = new Map<RuntimeHostClient, string[]>();
  const connect = RuntimeHostClient.connect.bind(RuntimeHostClient);
  context.mock.method(RuntimeHostClient, "connect", async options => {
    const client = await connect(options);
    clients.push(client);
    received.set(client, []);
    client.subscribeAllRuntimeEvents(update => received.get(client)!.push(update.snapshot.info.sessionId));
    return client;
  });
  const output: unknown[][] = [];
  context.mock.method(console, "log", (...args: unknown[]) => { output.push(args); });
  try {
    await taskListCommand(fixture.root, { noSpawn: true, json: true, limit: 1 });
    assert.equal(clients.length, 1);
    assert.deepEqual(output, [[JSON.stringify({ tasks: [], hasMore: false })]]);
    assert.deepEqual(received.get(clients[0]!), [], "a task list must not consume another session's historical snapshots");
    await taskCreateCommand(fixture.root, "Synthetic durable task", { json: true });
    assert.equal(received.get(clients[1]!)!.filter(id => id === "unrelated-session").length, 120,
      "mutation entry points retain their revision and event synchronization");
    const observer = await RuntimeHostClient.connect({ registration: fixture.registration, surface: "tui" });
    await observer.waitForReady();
    assert.equal(received.get(observer)!.filter(id => id === "unrelated-session").length, 120,
      "observer startup retains its complete replay contract");
    assert.equal(observer.getSnapshot().info.sessionId, snapshot.info.sessionId);
  } finally { await Promise.all(clients.map(client => client.close())); }
});
