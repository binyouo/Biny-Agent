/** 关闭闸门与运行数量无关；关闭后仍须拒绝新工作。 */
import assert from "node:assert/strict";
import { HostDrainingError, RuntimeHostAdmission } from "../src/runtime/host/admission.js";

const admission = new RuntimeHostAdmission();
assert.equal(admission.isDraining(), false);
assert.doesNotThrow(() => admission.assertAdmission());
admission.beginDrain();
assert.equal(admission.isDraining(), true);
assert.throws(() => admission.assertAdmission(), (error: unknown) => error instanceof HostDrainingError);
admission.beginDrain();
assert.throws(() => admission.assertAdmission(), (error: unknown) => error instanceof HostDrainingError);
console.log("runtime-host drain tests passed");
