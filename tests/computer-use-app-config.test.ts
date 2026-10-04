import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
const restored = configSchema.parse({ ...defaultConfig, computer: { enabled: true } });
assert.equal(Reflect.get(restored.computer, "strictApproval"), false, "旧配置恢复为非严格应用审批，保持连续操作");
assert.deepEqual(Reflect.get(restored.computer, "apps"), []);
console.log("computer app configuration tests passed");
