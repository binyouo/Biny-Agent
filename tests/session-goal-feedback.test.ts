import assert from "node:assert/strict";
import { changeSessionGoal } from "../src/desktop/renderer/src/components/workspace/sessionGoalControl.js";

const goal = { sessionId: "session-a", goalId: "goal-a", revision: 3, objective: "原始目标" };
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
events.length = 0;
const edited = await changeSessionGoal(goal, { operation: "session.goal.set", previousObjective: goal.objective, objective: "  修改后的目标\n保留第二行  " }, async (operation, payload) => {
  assert.equal(operation, "session.goal.set");
  assert.deepEqual(payload, { sessionId: "session-a", expected: { goalId: "goal-a", revision: 3 }, objective: "修改后的目标\n保留第二行" });
}, feedback, new AbortController().signal);
assert.equal(edited, true, "The editor closes only after a successful save.");
assert.equal(await changeSessionGoal({ ...goal, revision: 4 }, { operation: "session.goal.set", previousObjective: goal.objective, objective: "用量更新后保存" }, async (_operation, payload) => {
  assert.deepEqual(payload.expected, { goalId: goal.goalId, revision: 4 });
}, feedback, new AbortController().signal), true, "Usage-only revision updates must allow edits with the latest revision");
const failedEdit = await changeSessionGoal(goal, { operation: "session.goal.set", previousObjective: goal.objective, objective: "保留失败草稿" }, async () => { throw failure; }, feedback, new AbortController().signal);
assert.equal(failedEdit, false, "A rejected edit keeps its draft available.");
const emptyEdit = await changeSessionGoal(goal, { operation: "session.goal.set", previousObjective: goal.objective, objective: " \n " }, async () => { assert.fail("Empty edits must not reach the runtime"); }, feedback, new AbortController().signal);
assert.equal(emptyEdit, false);
assert.deepEqual(events.at(-1), ["error", "目标不能为空。"]);
const concurrentEdit = await changeSessionGoal({ ...goal, objective: "其他入口的新目标", revision: 4 }, { operation: "session.goal.set", previousObjective: goal.objective, objective: "我的草稿" }, async () => { assert.fail("Concurrent objective changes must not be overwritten"); }, feedback, new AbortController().signal);
assert.equal(concurrentEdit, false);
assert.deepEqual(events.at(-1), ["error", "目标已变化，请取消编辑后重新打开。"]);
assert.equal(await changeSessionGoal(goal, { operation: "session.goal.set", previousObjective: goal.objective, objective: `  ${goal.objective}  ` }, async () => { assert.fail("Unchanged edits must not reach the runtime"); }, feedback, new AbortController().signal), true);
console.log("session goal feedback tests passed");
