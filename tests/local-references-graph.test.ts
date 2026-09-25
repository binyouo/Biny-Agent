/** 显式关系和消息正文自动关系随源变化重建，目标失效不能留下可打开反链。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService, LocalReferenceGraph } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-graph-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  const sourceFile = path.join(directory, "source.jsonl");
  const targetFile = path.join(directory, "target.jsonl");
  const writeSource = async (content: string): Promise<void> => await writeFile(sourceFile,
    JSON.stringify({ type: "user_message", messageId: "m1", content }) + "\n");
  await writeSource("参考 @[目标](biny://thread/target)");
  await writeFile(targetFile, JSON.stringify({ type: "user_message", messageId: "m2", content: "目标正文" }) + "\n");
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", path: workspace, name: "项目" }] });
  const graph = new LocalReferenceGraph(root, service);
  const source = "biny://thread/source/message/m1";
  const target = "biny://thread/target";
  assert.deepEqual((await graph.backlinks(target, "p1")).map((link) => link.sourceUri), [source]);
  await writeSource("引用已删除");
  assert.equal((await graph.backlinks(target, "p1")).length, 0);
  assert.equal(await graph.link(source, target, "p1"), true);
  assert.equal(await graph.link(source, target, "p1"), false);
  assert.deepEqual((await graph.outlinks(source, "p1")).map((link) => link.targetUri), [target]);
  assert.equal(await graph.unlink(source, target, "p1"), true);
  assert.equal((await graph.backlinks(target, "p1")).length, 0);
  await rm(targetFile);
  await assert.rejects(graph.link(source, target, "p1"));
  graph.close();
  console.log("local reference graph tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
