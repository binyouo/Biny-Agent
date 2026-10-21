import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { access, mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { TurnStore } from "../src/session/turnStore.js";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-cleanup-"));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "cleanup-session");
  recorder.record({ type: "user_message", content: "cleanup" });
  await recorder.close();

  await new TurnStore(root, recorder.sessionId).save("cleanup", undefined, [{ role: "user", content: "cleanup" }], 0);
  await deleteSessionArtifacts(root, recorder.sessionId);

  await assert.rejects(access(sessionFilePath(root, recorder.sessionId)));
  await assert.rejects(access(path.join(agentDir(root), "turns", `${recorder.sessionId}.json`)));

  // 单步失败不能留下半删除状态：JSONL 已被并发删掉时，其余产物仍要清理，最后如实报错。
  const partial = new SessionRecorder(root, "cleanup-partial");
  partial.record({ type: "user_message", content: "partial" });
  await partial.close();
  await new TurnStore(root, partial.sessionId).save("partial", undefined, [{ role: "user", content: "partial" }], 0);
  await rm(sessionFilePath(root, partial.sessionId));
  await assert.rejects(deleteSessionArtifacts(root, partial.sessionId), /Session not found/);
  await assert.rejects(access(path.join(agentDir(root), "turns", `${partial.sessionId}.json`)));

  // 并发 save 共用固定临时名会互相截断；随机临时名下落盘的必须是其中一份完整数据。
  const concurrent = new TurnStore(root, "cleanup-concurrent");
  await Promise.all([
    concurrent.save("first", undefined, [{ role: "user", content: "first" }], 1),
    concurrent.save("second", undefined, [{ role: "user", content: "second" }], 2)
  ]);
  const saved = await concurrent.load();
  assert.ok(saved);
  assert.equal(saved.prompt === "first" || saved.prompt === "second", true, "the persisted turn must be one complete version");
  assert.equal(saved.completedSteps, saved.prompt === "first" ? 1 : 2);
  console.log("session cleanup tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
