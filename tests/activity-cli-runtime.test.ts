/** 用真实 CLI、配置与本地 SQLite 验证无模型时的骨架日报链路。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-cli-runtime-"));
try {
  await mkdir(path.join(root, "agent"));
  await writeFile(path.join(root, "agent", "config.json"), JSON.stringify({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, outputDirectory: path.join(root, "snapshots") }
  }));
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    path.resolve("src/cli/index.ts"),
    "activity", "report", "today", "--skeleton", "--json"
  ], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { date: string; markdown: string; sessionCount: number; narrativeModel?: string };
  assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(report.sessionCount, 0);
  assert.equal(report.narrativeModel, undefined);
  assert.match(report.markdown, /工作日记/u);
  await access(path.join(root, "agent", "agent.sqlite"));
  const status = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    path.resolve("src/cli/index.ts"),
    "activity", "status"
  ], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Database: .*agent\.sqlite/u);
  assert.match(status.stdout, /Snapshots: /u);
} finally {
  await rm(root, { recursive: true, force: true });
}
