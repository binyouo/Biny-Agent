import assert from "node:assert/strict";
import { changeSessionGoal } from "../src/desktop/renderer/src/components/workspace/sessionGoalControl.js";

const goal = { sessionId: "session-a", goalId: "goal-a", revision: 3 };
const events: unknown[] = [];
const feedback = { pending: (value: boolean) => { events.push(["pending", value]); }, error: (value?: string) => { events.push(["error", value]); }, report: (error: unknown) => { events.push(["report", error]); } };

// 模拟异步服务边界与组件生命周期，不运行界面或触发点击。
const controller = new AbortController();
let reject!: (error: Error) => void;
const previous = changeSessionGoal(goal, "session.goal.clear", async (operation, payload) => {
  assert.equal(operation, "session.goal.clear");
  assert.deepEqual(payload, { sessionId: "session-a", expected: { goalId: "goal-a", revision: 3 } });
  await new Promise<void>((_resolve, fail) => { reject = fail; });
}, feedback, controller.signal);
const beforeUnmount = [...events];
controller.abort();
reject(new Error("old session failed"));
await previous;
assert.deepEqual(events, beforeUnmount, "an unmounted goal must emit neither local feedback nor a global error");

events.length = 0;
const successController = new AbortController();
let resolve!: () => void;
const oldSuccess = changeSessionGoal(goal, "session.goal.clear", async () => { await new Promise<void>((finish) => { resolve = finish; }); }, feedback, successController.signal);
const beforeSuccessfulUnmount = [...events];
successController.abort(); resolve();
await oldSuccess;
assert.deepEqual(events, beforeSuccessfulUnmount, "a successful response after unmount must not update local pending feedback");

events.length = 0;
const failure = new Error("current session failed");
await changeSessionGoal(goal, "session.goal.pause", async () => { throw failure; }, feedback, new AbortController().signal);
assert.deepEqual(events, [["pending", true], ["error", undefined], ["error", failure.message], ["report", failure], ["pending", false]], "a current failure must remain visible and enable retry");

events.length = 0;
await changeSessionGoal(goal, "session.goal.resume", async () => undefined, feedback, new AbortController().signal);
assert.deepEqual(events, [["pending", true], ["error", undefined], ["pending", false]]);
events.length = 0;
await changeSessionGoal(goal, "session.goal.pause", async () => { assert.fail("an unmounted goal must not start another mutation"); }, feedback, controller.signal);
assert.deepEqual(events, []);
console.log("session goal feedback tests passed");
