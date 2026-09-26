/** 空 @ 候选按真实种类保留发现机会，不被构建文件占满。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { projectSessionsDir } from "../src/config/paths.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { LocalReferenceService } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-discovery-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  await mkdir(path.join(workspace, "out"));
  for (let index = 0; index < 40; index += 1) await writeFile(path.join(workspace, "out", `asset-${index}.js`), "generated");
  await writeFile(path.join(workspace, "notes.md"), "项目笔记");
  await mkdir(path.join(workspace, ".biny", "agents"), { recursive: true });
  await writeFile(path.join(workspace, ".biny", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: 检查代码\n---\n检查改动的正确性。\n");
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "thread-1.jsonl"), [
    { type: "user_message", messageId: "m1", content: "讨论方案" },
    { type: "tool_call", tool: "Read", toolCallId: "call-1", args: { path: "notes.md" } }
  ].map((event) => JSON.stringify(event) + "\n").join(""));
  const memory = new MemoryStorage(workspace, { agentDir: root });
  await memory.writeEntry({ content: "长期偏好" });
  memory.close();
  const config = structuredClone(defaultConfig);
  config.providers.fixture = { type: "openai-compatible", baseUrl: "https://example.invalid" };
  config.extensions.subagent.enabled = true;
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", path: workspace, name: "项目" }],
    loadConfig: async () => config,
    runtimeEntries: async () => [{ kind: "task", id: "task-1", label: "任务一", content: "任务一" }] });
  const candidates = await service.search("", "p1", undefined, 30, "Asia/Shanghai");
  assert.deepEqual(candidates.filter((item) => item.kind === "date").map((item) => item.label), ["今天", "本周", "下周一"]);
  assert.equal((await service.search("本周", "p1", "date", 5, "Asia/Shanghai"))[0]?.label, "本周");
  for (const kind of ["date", "project", "file", "thread", "message", "tool-call", "memory", "provider", "task", "agent"]) {
    assert.equal(candidates.some((item) => item.kind === kind), true, `${kind} should be discoverable`);
  }
  assert.equal(candidates.some((item) => item.uri.includes("/out/")), false);
  assert.equal((await service.search("asset-0", "p1", "file")).some((item) => item.uri.includes("/out/")), true);
  const agent = candidates.find((item) => item.kind === "agent");
  assert.match((await service.resolve(agent!.uri, "p1")).content, /检查改动/u);
  await rm(path.join(workspace, ".biny", "agents", "reviewer.md"));
  await assert.rejects(service.resolve(agent!.uri, "p1"));
  console.log("local reference discovery tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
