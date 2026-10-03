/** 系统启动为注入的进程边界，不打开用户浏览器。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as assets from "../src/browser/extensionAssets.js";

test("Chrome 安装入口只启动扩展管理页，参数没有凭据或自动加载标志", async () => {
  const calls: unknown[] = [];
  await assets.openChromeExtensionManager(async (...args) => { calls.push(args); }, "darwin");
  assert.deepEqual(calls, [["/usr/bin/open", ["-a", "Google Chrome", "chrome://extensions/"], { timeout: 5000 }]]);
});

test("Chrome 未安装与平台不支持时给出可操作错误，启动失败不重试", async () => {
  let calls = 0;
  const fail = async () => { calls++; throw new Error("process details"); };
  await assert.rejects(assets.openChromeExtensionManager(fail, "darwin"), /无法打开 Chrome.*chrome:\/\/extensions/);
  assert.equal(calls, 1);
  await assert.rejects(assets.openChromeExtensionManager(fail, "darwin"), { code: "unavailable" });
  assert.equal(calls, 2);
  await assert.rejects(assets.openChromeExtensionManager(fail, "linux"), /macOS.*chrome:\/\/extensions/);
  assert.equal(calls, 2);
});
