import assert from "node:assert/strict";
import { OperationDispatcher, operationLane, operationLaneKey } from "../src/runtime/host/operations.js";

assert.equal(operationLane("runtime.restart"), "run");
assert.equal(operationLane("session.ensure"), "run");
assert.equal(operationLane("agent.permission-mode"), "run");
assert.equal(operationLaneKey("runtime.restart", {}, "session-a"), "session-a");
assert.equal(operationLaneKey("session.ensure", { sessionId: "session-a" }, "primary"), "session-a");
assert.equal(operationLane("run.submit"), "run");
assert.equal(operationLane("host.info"), "query");
assert.equal(operationLane("memory", { action: "archive-chains" }), "query");
assert.equal(operationLane("run.cancel"), "run");
assert.equal(operationLane("capability.fail"), "control");
assert.equal(operationLane("graph.start"), "admission");

const dispatcher = new OperationDispatcher();
const order: string[] = [];
let releaseFirst!: () => void;
const first = dispatcher.dispatch("mutation", async () => {
  order.push("first:start");
  await new Promise<void>((resolve) => { releaseFirst = resolve; });
  order.push("first:end");
});
const second = dispatcher.dispatch("mutation", async () => {
  order.push("second");
});

await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(order, ["first:start"]);
releaseFirst();
await Promise.all([first, second]);
assert.deepEqual(order, ["first:start", "first:end", "second"]);

const runDispatcher = new OperationDispatcher();
const runOrder: string[] = [];
let releaseSessionA!: () => void;
const sessionA = runDispatcher.dispatch("run", async () => {
  runOrder.push("a:start");
  await new Promise<void>((resolve) => { releaseSessionA = resolve; });
  runOrder.push("a:end");
}, "session-a");
const sessionASecond = runDispatcher.dispatch("run", async () => {
  runOrder.push("a:second");
}, "session-a");
const sessionB = runDispatcher.dispatch("run", async () => {
  runOrder.push("b");
}, "session-b");
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(runOrder, ["a:start", "b"], "不同 session 的 run lane 应并行，同 session 仍串行");
releaseSessionA();
await Promise.all([sessionA, sessionASecond, sessionB]);
assert.deepEqual(runOrder, ["a:start", "b", "a:end", "a:second"]);

let releaseQuery!: () => void;
const pendingQuery = dispatcher.dispatch("query", () => new Promise<void>((resolve) => { releaseQuery = resolve; }));
let snapshotRead = false;
const snapshotQuery = dispatcher.dispatch("query", async () => { snapshotRead = true; });
await new Promise<void>((resolve) => setTimeout(resolve, 0));
try {
  assert.equal(snapshotRead, true, "wait-idle 未完成时其他查询仍应完成");
} finally {
  releaseQuery();
  await Promise.all([pendingQuery, snapshotQuery]);
}

console.log("runtime-host operations tests passed");
