/** ref CLI 的文本与 JSON 入口复用引用库。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { projectSessionsDir } from "../src/config/paths.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ref-cli-")));
const workspace = path.join(root, "project");
const run = async (...args: string[]): Promise<string> => (await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"), "ref", ...args],
  { cwd: workspace, env: { ...process.env, BINY_AGENT_DIR: root }, timeout: 30_000 })).stdout.trim();
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "thread-1.jsonl"), JSON.stringify({ type: "user_message", messageId: "m1", content: "明天开会" }) + "\n");
  const kinds = JSON.parse(await run("kinds", "--json")) as Array<{ kind: string }>;
  assert.equal(kinds.some((item) => item.kind === "message"), true);
  const results = JSON.parse(await run("search", "开会", "--json")) as Array<{ uri: string }>;
  assert.equal(results[0]?.uri, "biny://thread/thread-1/message/m1");
  assert.match(await run("resolve", results[0]!.uri), /明天开会/u);
  assert.equal(JSON.parse(await run("resolve", results[0]!.uri, "--json")).content, "明天开会");
  assert.equal(await run("token", results[0]!.uri), `@[明天开会](${results[0]!.uri})`);
  assert.match(await run("context", `请处理 @[消息](${results[0]!.uri})`), /明天开会/u);
  const target = "biny://thread/thread-1";
  assert.equal(JSON.parse(await run("link", results[0]!.uri, target, "--json")).linked, true);
  assert.equal((JSON.parse(await run("backlinks", target, "--json")) as Array<{ sourceUri: string }>)[0]?.sourceUri, results[0]!.uri);
  const snippet = JSON.parse(await run("snippet", results[0]!.uri, "--start", "0", "--end", "2", "--json")) as { uri: string };
  assert.equal(JSON.parse(await run("resolve", snippet.uri, "--json")).content, "明天");
  assert.equal(JSON.parse(await run("pin", snippet.uri, "--json")).pinned, true);
  assert.equal((JSON.parse(await run("pins", "--json")) as Array<{ uri: string }>)[0]?.uri, snippet.uri);
  const scratch = JSON.parse(await run("scratch", "暂存", "--json")) as { uri: string };
  assert.equal(JSON.parse(await run("resolve", scratch.uri, "--json")).content, "暂存");
  assert.equal(JSON.parse(await run("promote", scratch.uri, "--json")).promoted, true);
  await assert.rejects(run("resolve", "biny://file/..%2Fsecret"));
  console.log("local reference CLI tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
