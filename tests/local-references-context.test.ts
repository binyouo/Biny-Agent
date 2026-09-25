/** Runtime 只把当前工作区真实引用的有界正文放进非权威上下文。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService, localReferenceContext } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-context-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "thread-1.jsonl"), JSON.stringify({ type: "user_message", messageId: "m1", content: "真实需求正文" }) + "\n");
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", path: workspace, name: "项目" }] });
  const context = await localReferenceContext("请看 @[需求](biny://thread/thread-1/message/m1)", service, "p1", 100);
  assert.match(context, /真实需求正文/u);
  assert.equal((await localReferenceContext("@[伪造](biny://thread/other/message/m1)", service, "p1", 100)).includes("真实需求正文"), false);
  assert.ok(context.length <= 100);
  assert.equal(await localReferenceContext("没有引用", service, "p1", 100), "");
  console.log("local reference context tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
