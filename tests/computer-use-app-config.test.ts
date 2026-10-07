import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { computerSettingsSchema } from "../src/computer/protocol.js";
for (const config of [configSchema.parse({ ...defaultConfig, computer: undefined }), configSchema.parse({ ...defaultConfig, computer: {} }), configSchema.parse(defaultConfig)]) {
  assert.equal(config.computer.enabled, true, "缺省配置启用桌面控制，避免新安装或缺少字段的配置拒绝第一次调用");
}
assert.equal(computerSettingsSchema.parse({}).enabled, true);
assert.equal(configSchema.parse({ ...defaultConfig, computer: { enabled: false } }).computer.enabled, false, "用户明确关闭的设置不能被默认值覆盖");
const restored = configSchema.parse({ ...defaultConfig, computer: { enabled: true } });
assert.equal(Reflect.get(restored.computer, "strictApproval"), false, "旧配置恢复为非严格应用审批，保持连续操作");
assert.deepEqual(Reflect.get(restored.computer, "apps"), []);
console.log("computer app configuration tests passed");
