/** 真实原生链路 smoke 使用合成图像，不读取用户屏幕、不申请权限。 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
if (process.platform !== "darwin") {
  console.log("SKIP: native Activity smoke requires macOS");
} else {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [fileURLToPath(new URL("./activity-native-smoke.mjs", import.meta.url))], {stdio:"inherit", env, timeout:60000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
