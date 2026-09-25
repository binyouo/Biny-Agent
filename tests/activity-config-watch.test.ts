/** 真实文件原子替换驱动采集配置更新，不启动系统截图，也不读取用户配置。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-config-watch-"));
const store = createFileConfigStore(root, { globalDir: root });
const startsPath = path.join(root, "starts");
const updatesPath = path.join(root, "updates");
const inputMonitorPath = path.join(root, "sidecar.mjs");
await writeFile(inputMonitorPath, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'start') appendFileSync(${JSON.stringify(startsPath)}, JSON.stringify(command.settings) + '\\n');
  if (command.type === 'settings_updated') appendFileSync(${JSON.stringify(updatesPath)}, JSON.stringify(command.settings) + '\\n');
  if (command.type === 'stop') process.exit(0);
});
`, { mode: 0o700 });
const service = new ActivityRecorderService({ agentDir: root, configStore: store, inputMonitorPath });
const config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), enabled: false } };
const starts = async (): Promise<Array<typeof config.activity>> => (await readFile(startsPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const updates = async (): Promise<Array<typeof config.activity>> => (await readFile(updatesPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const save = async (): Promise<void> => {
  const temporary = path.join(root, "next-config.json");
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await rename(temporary, store.configPath!());
};
try {
  await store.save(config);
  await service.initialize();
  assert.equal(service.snapshot().state, "paused");
  config.activity.enabled = true;
  await save();
  await waitFor(async () => (await starts()).length === 1);
  // 配置变化重启录制，重新尝试原生截图；相同配置不重启。
  config.activity.sensitiveApplications = [...config.activity.sensitiveApplications, "test.private.app"];
  await save();
  await waitFor(async () => (await starts()).length === 2);
  assert.equal((await starts()).length, 2);
  await save();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await starts()).length, 2, "内容相同的保存不能重启采集器");
  assert.equal((await updates()).length, 0, "内容相同的保存不能重复热更新");
  await writeFile(store.configPath!(), "{ invalid");
  await waitFor(async () => service.snapshot().state === "error");
  await save();
  await waitFor(async () => (await starts()).length === 3);
  // 反复切换真实子进程和配置监听，确认旧停止回调不会关掉新一代采集或重复启动。
  for (let cycle = 0; cycle < 20; cycle++) {
    config.activity.enabled = false;
    await save();
    await waitFor(async () => service.snapshot().state === "paused");
    config.activity.enabled = true;
    await save();
    await waitFor(async () => (await starts()).length === 4 + cycle);
  }
  config.activity.enabled = false;
  await save();
  await waitFor(async () => service.snapshot().state === "paused");
  await service.stop();
  config.activity.enabled = true;
  await save();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(service.snapshot().state, "stopped", "显式停止后配置写入不能偷偷拉起采集");
  assert.equal((await starts()).length, 23);
} finally {
  await service.stop();
  await rm(root, { recursive: true, force: true });
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("配置更新未生效");
}
