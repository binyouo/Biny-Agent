import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

// UI 复刻的判据：设置页展示的数据必须真的来自原生 daemon。
// 这里直接跑真 daemon，验证喂给渲染层的形状与内容。
test("native daemon feeds the settings surface with live diagnostics", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const reply = await driver.diagnostics();
    const data = reply.data as { accessibility?: string; screenRecording?: string; version?: string; uptime?: number };
    assert.equal(typeof data.version, "string", "doctor must report a version for the helper row");
    assert.equal(typeof data.uptime, "number", "doctor must report uptime for the helper row");
    assert.ok(["granted", "denied"].includes(data.accessibility ?? ""), "accessibility state drives the permission grid");
    assert.ok(["granted", "denied"].includes(data.screenRecording ?? ""), "screen recording state drives the permission grid");

    const list = await driver.list("settings-e2e", undefined);
    const apps = (list.data as { apps?: { name: string; running: boolean }[] }).apps ?? [];
    assert.ok(apps.length > 0, "settings app list must render at least one running app");
    assert.ok(apps.every(app => typeof app.name === "string" && app.name.length > 0), "every app row needs a label");
  } finally {
    await driver.dispose();
  }
});

// PiP 的 3fps 帧泵靠 reply.images；截图必须从 daemon 的落盘路径读回来。
test("observe returns a decodable frame so the preview pump has something to paint", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("pip-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number }[] }).apps ?? [];
    assert.ok(apps.length > 0, "need at least one running app to observe");
    const reply = await driver.observe("pip-e2e", { pid: apps[0].pid } as never);
    const images = reply.images ?? [];
    assert.equal(images.length, 1, "observe must hand back exactly one frame for the preview window");
    const frame = images[0] as { mimeType: string; dataBase64: string };
    assert.equal(frame.mimeType, "image/jpeg");
    // JPEG 以 FFD8FF 开头；base64 前缀必须是 /9j/。
    assert.ok(frame.dataBase64.startsWith("/9j/"), "frame must be a real jpeg, not a placeholder");
  } finally {
    await driver.dispose();
  }
});
