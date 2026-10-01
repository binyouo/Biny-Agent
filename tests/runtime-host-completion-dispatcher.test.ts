import assert from "node:assert/strict";
import { OperationCompletion, OperationDispatcher, operationLane } from "../src/runtime/host/operations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const dispatcher = new OperationDispatcher();
const admission = deferred<void>();
const completion = deferred<string>();
const entered = deferred<void>();
const order: string[] = [];
let replied = false;
const task = dispatcher.dispatch(operationLane("task.run"), async () => {
  order.push("validate");
  entered.resolve();
  await admission.promise;
  order.push("persist-and-start");
  return new OperationCompletion(completion.promise);
});
void task.then(() => { replied = true; });
const capability = dispatcher.dispatch(operationLane("capability.result"), async () => { order.push("capability"); });
await entered.promise;
await dispatcher.dispatch("query", async () => { order.push("query"); });
assert.deepEqual(order, ["validate", "query"], "the admission boundary must stay serialized until durable start finishes");
admission.resolve();
await capability;
assert.deepEqual(order, ["validate", "query", "persist-and-start", "capability"]);
assert.equal(replied, false, "releasing admission must not return an unfinished RPC result");
completion.resolve("final result");
assert.equal(await task, "final result");

const failure = deferred<string>();
const failedTask = dispatcher.dispatch("admission", async () => new OperationCompletion(failure.promise));
const failureResult = assert.rejects(failedTask, /controlled completion error/u);
await dispatcher.dispatch("admission", async () => "later admission");
failure.reject(new Error("controlled completion error"));
await failureResult;
await assert.rejects(dispatcher.dispatch("admission", async () => { throw new Error("controlled admission error"); }), /controlled admission error/u);
assert.equal(await dispatcher.dispatch("admission", async () => "queue recovered"), "queue recovered");

assert.equal(operationLane("task.cancel"), "control");
assert.equal(operationLane("task.approve"), "admission");
assert.equal(operationLane("task.run"), "admission");
assert.equal(operationLane("reflection.run"), "admission");
assert.equal(operationLane("capability.result"), "admission");
assert.equal(operationLane("runtime.restart"), "run");
assert.equal(operationLane("agent.permission-mode"), "run");
console.log("runtime host completion dispatcher tests passed");
