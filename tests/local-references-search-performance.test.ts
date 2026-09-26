/** @ 搜索只依赖当前项目的权威对象，其他项目损坏或 Runtime 断开不阻塞本地候选。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService } from "../src/session/localReferences.js";

const run = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ref-search-perf-")));
const workspace = path.join(root, "current");
const other = path.join(root, "other");
const currentSessions = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
const otherSessions = projectSessionsDir(other, { env: { BINY_AGENT_DIR: root } });
try {
  await Promise.all([mkdir(workspace), mkdir(other), mkdir(currentSessions, { recursive: true }), mkdir(otherSessions, { recursive: true })]);
  const currentFile = path.join(currentSessions, "thread-current.jsonl");
  await writeFile(currentFile, [
    { type: "user_message", messageId: "m1", slotId: "slot-1", content: "当前消息" },
    { type: "tool_call", tool: "Read", toolCallId: "call-1", args: { path: "notes.md" } }
  ].map((event) => JSON.stringify(event) + "\n").join(""));
  await writeFile(path.join(otherSessions, "thread-other.jsonl"), '{"type":"user_message","content":"其他项目"}\n');
  await symlink(path.join(otherSessions, "thread-other.jsonl"), path.join(currentSessions, "thread-link.jsonl"));
  const service = new LocalReferenceService({ root, projects: [{ id: "current", path: workspace, name: "当前项目" }],
    runtimeEntries: async () => [{ kind: "task", id: "task-1", label: "当前任务", content: "当前任务" }] });

  // 未筛选搜索仍能发现本地与 Runtime 对象，限定种类则不触发无关 Runtime 查询。
  const all = await service.search("", "current");
  for (const kind of ["thread", "message", "tool-call", "task"])
    assert.equal(all.some((item) => item.kind === kind), true, `${kind} should be discoverable`);
  const localOnly = new LocalReferenceService({ root, projects: [{ id: "current", path: workspace, name: "当前项目" }],
    runtimeEntries: async () => { throw new Error("Runtime should not start"); } });
  assert.equal((await localOnly.search("", "current", "thread")).some((item) => item.label === "thread-current"), true);
  assert.equal((await localOnly.search("", "current", "message")).some((item) => item.label === "当前消息"), true);
  assert.equal((await localOnly.search("", "current", "tool-call")).some((item) => item.label === "Read"), true);

  // 其他项目不可读时，当前项目的服务与 CLI 搜索仍须完成。
  await chmod(otherSessions, 0o000);
  assert.deepEqual((await service.search("", "current", "thread")).map((item) => item.label), ["thread-current"]);
  if (process.getuid?.() !== 0) {
    const { stdout } = await run(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), path.resolve("src/cli/index.ts"), "ref", "search", "", "--kind", "thread", "--json"],
      { cwd: workspace, env: { ...process.env, BINY_AGENT_DIR: root } });
    assert.deepEqual(JSON.parse(stdout).map((item: { label: string }) => item.label), ["thread-current"]);
  }
  await chmod(otherSessions, 0o700);

  // 同一服务下一次查询必须看到会话编辑与删除，不能因加速而复用过期消息。
  await writeFile(currentFile, JSON.stringify({ type: "user_message", messageId: "m2", slotId: "slot-1", content: "修改后消息" }) + "\n");
  assert.deepEqual((await service.search("", "current", "message")).map((item) => item.label), ["修改后消息"]);
  assert.deepEqual(await service.search("", "current", "tool-call"), []);
  await rm(currentFile);
  assert.deepEqual(await service.search("", "current", "thread"), []);

  // Runtime 读取失败只影响相应种类；本地候选仍可供用户选择。
  const resilient = await localOnly.search("", "current");
  assert.equal(resilient.some((item) => item.kind === "project"), true);
  console.log("local reference search performance tests passed");
} finally {
  await chmod(otherSessions, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
