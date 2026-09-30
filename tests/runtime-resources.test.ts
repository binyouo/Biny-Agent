import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { loadSkills } from "../src/extensions/skills.js";
import { RuntimeHostResourceRegistry, RuntimeHostResourceScope } from "../src/runtime/host/resources.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-resources-"));

try {
  const duplicateSkill = "---\nname: duplicate-skill\ndescription: Duplicate test skill\n---\n";
  await mkdir(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill"), { recursive: true });
  await mkdir(path.join(workspaceRoot, ".agents", "skills", "duplicate-skill"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill);
  await writeFile(path.join(workspaceRoot, ".agents", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill);
  const duplicateBundle = await loadSkills({
    workspaceRoot,
    projectPaths: [],
    globalRoot: path.join(workspaceRoot, "no-global-skills")
  });
  assert.equal(duplicateBundle.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(duplicateBundle.conflicts.length, 1);
  assert.match(duplicateBundle.conflicts[0]?.winner.path ?? "", /\.biny[\\/]skills/);
  assert.match(duplicateBundle.conflicts[0]?.shadowed[0]?.path ?? "", /\.agents[\\/]skills/);
  assert.equal(duplicateBundle.warnings.some((warning) => warning.includes("Skill conflict")), true);
  assert.deepEqual(duplicateBundle.errors, [], "重复 Skill 只是诊断，不应让资源进入 degraded");

  const registry = new RuntimeHostResourceRegistry();
  const first = registry.acquire(workspaceRoot, defaultConfig);
  const second = registry.acquire(workspaceRoot, defaultConfig);
  assert.equal(first, second, "同一 workspace 和扩展配置应复用资源 scope");
  assert.equal(first.snapshot().state, "loading");
  assert.equal(first.snapshot().mcp.pending, false);

  await first.start();
  assert.equal(first.snapshot().state, "ready");
  assert.deepEqual(first.readiness(), { revision: first.snapshot().revision, state: "ready" });
  assert.ok(Buffer.byteLength(JSON.stringify(first.readiness())) < 100, "高频就绪摘要不应包含能力目录");
  const revision = first.snapshot().revision;
  const refresh = first.refreshSkills(true);
  assert.equal(first.refreshSkills(), refresh, "并发会话复用同一次 Skill 扫描");
  await refresh;
  assert.equal(first.snapshot().revision, revision, "未变化的 Skill 不应递增资源版本或发布快照");
  await writeFile(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill.replace("Duplicate test", "Updated test"));
  await first.refreshSkills();
  assert.equal(first.skills.skills.find((skill) => skill.name === "duplicate-skill")?.description, "Duplicate test skill", "短期复用目录，不重复扫描");
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  mock.timers.tick(30_001);
  await first.refreshSkills();
  mock.timers.reset();
  assert.equal(first.skills.skills.find((skill) => skill.name === "duplicate-skill")?.description, "Updated test skill");
  assert.equal(first.snapshot().revision, revision + 1, "变化的目录仅发布一次");
  await writeFile(path.join(workspaceRoot, ".biny", "skills", "duplicate-skill", "SKILL.md"), duplicateSkill.replace("Duplicate test", "Installed test"));
  await first.refreshSkills(true);
  assert.equal(first.skills.skills.find((skill) => skill.name === "duplicate-skill")?.description, "Installed test skill", "安装后的强制刷新不等待 TTL");

  const slow = new RuntimeHostResourceScope(workspaceRoot, {
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: { slow: { enabled: true, command: "unused", args: [], cwd: ".", stderr: "ignore", timeoutMs: 60_000 } } }
  });
  let connected = false;
  let connecting = true;
  let finishConnection!: () => void;
  slow.mcp.connectConfiguredServers = () => new Promise<void>((resolve) => { finishConnection = resolve; });
  slow.mcp.listServers = () => [{ name: "slow", command: "unused", transport: "stdio", enabled: true, connected, connecting, toolNames: [], promptNames: [], hasResources: false }];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const starting = slow.start();
    await slow.refreshSkills();
    assert.equal(slow.snapshot().state, "ready", "本地目录准备完成后，MCP 首连不能继续占用全局 loading");
    assert.equal(slow.snapshot().mcp.pending, true);
    assert.equal(slow.start(), starting, "多个会话应加入同一次启动，不重建连接");
    mock.timers.tick(10_000);
    await starting;
    assert.equal(slow.snapshot().state, "ready", "仍在连接不应被标记为 degraded");
    assert.equal(slow.snapshot().mcp.pending, true, "baseline 超时不能清除仍在连接的 pending");
    connected = true;
    connecting = false;
    finishConnection();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(slow.snapshot().mcp.pending, false);
    assert.equal(slow.snapshot().state, "ready");
  } finally {
    mock.timers.reset();
    await slow.close();
  }

  const changedConfig = {
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      skills: [...defaultConfig.extensions.skills, ".biny/test-skills"]
    }
  };
  const isolated = registry.acquire(workspaceRoot, changedConfig);
  assert.notEqual(isolated, first, "扩展配置变化不能复用旧资源 scope");

  await registry.release(first);
  assert.equal(second.snapshot().state, first.snapshot().state, "仍有 session 引用时资源不能提前关闭");
  await registry.release(second);
  await registry.release(isolated);
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("runtime resource tests passed");
