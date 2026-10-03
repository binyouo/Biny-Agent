import assert from "node:assert/strict";
import { isRuntimeHostAdmissionOperation } from "../src/runtime/host/admission.js";
import { operationLane, operationLaneKey } from "../src/runtime/host/operations.js";

assert.equal(operationLane("session.goal.get"), "query", "Goal reads cannot block or start a session runtime.");
for (const operation of ["session.goal.set", "session.goal.resume", "session.goal.pause", "session.goal.clear"]) {
  assert.equal(operationLane(operation), "run", "Goal control shares the target session's short causal lane.");
  assert.equal(operationLaneKey(operation, { sessionId: "target-session" }), "target-session");
}
for (const operation of ["session.goal.set", "session.goal.resume"]) {
  assert.equal(isRuntimeHostAdmissionOperation(operation), true, "Starting Goal work must honor Host draining.");
}
for (const operation of ["session.goal.get", "session.goal.pause", "session.goal.clear"]) {
  assert.equal(isRuntimeHostAdmissionOperation(operation), false, "Goal inspection and stopping remain available during drain.");
}
for (const input of ["/goal", "/goal show"]) {
  assert.equal(operationLane("command", { input }), "query", "Goal slash reads remain available while mutations are pending.");
  assert.equal(operationLaneKey("command", { input, sessionId: "target-session" }), undefined);
}
for (const input of ["/goal set finish the work", "/goal pause", "/goal resume", "/goal clear"]) {
  assert.equal(operationLane("command", { input }), "run", "Goal slash controls use the same short session lane as RPC.");
  assert.equal(operationLaneKey("command", { input, sessionId: "target-session" }), "target-session");
}
console.log("session goal admission tests passed");
