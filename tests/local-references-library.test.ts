/** 引用库只解析真实对象；消息定位使用稳定槽位及当前活动版本。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { LocalReferenceService, formatLocalReference, parseLocalReferenceUri } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-local-refs-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  await writeFile(path.join(workspace, "notes.txt"), "真实文件");
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "thread-1.jsonl");
  const events = [
    { type: "user_message", messageId: "m-old", slotId: "slot-1", content: "旧版问题" },
    { type: "user_message", messageId: "m-new", slotId: "slot-1", content: "新版问题" },
    { type: "message_version_selected", slotId: "slot-1", messageId: "m-new" }
  ];
  await writeFile(file, events.map((event) => JSON.stringify(event) + "\n").join(""));
  const memory = new MemoryStorage(workspace, { agentDir: root });
  const saved = await memory.writeEntry({ content: "长期事实" });
  assert.ok(saved.entry?.id);
  memory.close();
  const service = new LocalReferenceService({ root, projects: [{ id: "project-1", path: workspace, name: "项目一" }] });
  assert.deepEqual(parseLocalReferenceUri("biny://thread/thread-1/message/slot-1"), { kind: "message", threadId: "thread-1", id: "slot-1" });
  assert.throws(() => parseLocalReferenceUri("biny://file/..%2Fsecret"));
  assert.throws(() => parseLocalReferenceUri("biny://unknown/id"));
  assert.equal(formatLocalReference("新版问题", "biny://thread/thread-1/message/slot-1"), "@[新版问题](biny://thread/thread-1/message/slot-1)");
  assert.equal((await service.resolve("biny://thread/thread-1/message/slot-1", "project-1")).content, "新版问题");
  assert.equal((await service.referenceForMessage("thread-1", "m-new", "project-1")).uri, "biny://thread/thread-1/message/slot-1");
  assert.equal((await service.resolve("biny://thread/thread-1", "project-1")).kind, "thread");
  assert.equal((await service.resolve("biny://file/notes.txt", "project-1")).content, "真实文件");
  assert.equal((await service.resolve(`biny://memory/${saved.entry.id}`, "project-1")).content, "长期事实");
  assert.deepEqual((await service.search("新版", "project-1")).map((item) => item.kind), ["message"]);
  assert.equal((await service.search("notes", "project-1")).some((item) => item.kind === "file"), true);
  assert.equal((await service.search("2026-10-03", "project-1", "date", 5, "Asia/Shanghai"))[0]?.uri,
    "biny://date/2026-10-03/2026-10-04/Asia%2FShanghai");
  await assert.rejects(service.resolve("biny://thread/thread-1/message/missing", "project-1"));
  await assert.rejects(service.resolve("biny://thread/thread-1/message/slot-1", "foreign-project"));
  await rm(file);
  await assert.rejects(service.resolve("biny://thread/thread-1/message/slot-1", "project-1"));
  console.log("local reference library tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
