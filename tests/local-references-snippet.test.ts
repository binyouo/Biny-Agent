/** 片段必须是当前消息连续原文；临时引用有到期及显式转正状态。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService, LocalReferenceGraph } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-snippet-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "t1.jsonl");
  await writeFile(file, JSON.stringify({ type: "user_message", messageId: "m1", content: "甲乙丙丁" }) + "\n");
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", path: workspace, name: "项目" }] });
  const graph = new LocalReferenceGraph(root, service);
  const snippet = await graph.captureSnippet("biny://thread/t1/message/m1", 1, 3, "p1");
  assert.equal((await graph.resolve(snippet.uri, "p1")).content, "乙丙");
  assert.equal((await service.search("乙丙", "p1", "snippet"))[0]?.uri, snippet.uri);
  assert.equal((await graph.captureQuote("biny://thread/t1/message/m1", "乙丙", "p1")).uri, snippet.uri);
  await assert.rejects(graph.captureQuote("biny://thread/t1/message/m1", "不存在", "p1"));
  assert.equal(await graph.pin(snippet.uri, "p1"), true);
  assert.equal((await service.search("", "p1"))[0]?.uri, snippet.uri);
  await assert.rejects(graph.captureSnippet("biny://thread/t1/message/m1", 1, 8, "p1"));
  const scratch = await graph.createScratch("暂存原文", "p1", new Date("2026-10-03T00:00:00Z"), 1000);
  assert.equal((await graph.resolve(scratch.uri, "p1", new Date("2026-10-03T00:00:00.500Z"))).content, "暂存原文");
  await assert.rejects(graph.resolve(scratch.uri, "p1", new Date("2026-10-03T00:00:02Z")));
  assert.equal(await graph.promoteScratch(scratch.uri, "p1"), true);
  assert.equal((await graph.resolve(scratch.uri, "p1", new Date("2026-10-04T00:00:00Z"))).content, "暂存原文");
  await writeFile(file, JSON.stringify({ type: "user_message", messageId: "m1", content: "甲乙替换" }) + "\n");
  await assert.rejects(graph.resolve(snippet.uri, "p1"));
  graph.close();
  console.log("local reference snippet tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
