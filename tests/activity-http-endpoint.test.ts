/** Desktop Activity HTTP 入口的发现文件、认证访问和关闭清理。 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-activity-endpoint-"));
let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
try {
  endpoint = await startActivityHttpEndpoint({
    agentDir,
    loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory: path.join(agentDir, "snapshots") })
  });
  const discoveryPath = path.join(agentDir, "activity-api.json");
  const descriptor = JSON.parse(await readFile(discoveryPath, "utf8")) as { host: string; port: number; token: string; pid: number };
  assert.equal(descriptor.host, "127.0.0.1");
  assert.equal(descriptor.port, endpoint.port);
  assert.equal(descriptor.pid, process.pid);
  assert.equal(descriptor.token, endpoint.token);
  assert.ok(descriptor.token.length >= 32);
  assert.equal((await stat(discoveryPath)).mode & 0o777, 0o600);

  const url = `http://${descriptor.host}:${descriptor.port}/api/activity-recorder/config`;
  assert.equal((await fetch(url)).status, 401);
  const authorized = await fetch(url, { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json() as { enabled: boolean }).enabled, false);

  const reportUrl = `http://${descriptor.host}:${descriptor.port}/api/activity-recorder/report/2026-08-31?skeletonOnly=1`;
  const markdown = await fetch(reportUrl, { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("content-type") ?? "", /^text\/markdown/u);
  assert.match(await markdown.text(), /2026-08-31 打工日记/u);
  const json = await fetch(`${reportUrl}&format=json`, { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/u);
  assert.match((await json.json() as { markdown: string }).markdown, /2026-08-31 打工日记/u);

  const digest = await fetch(`http://${descriptor.host}:${descriptor.port}/api/activity-recorder/digest?lookbackMin=5&maxAnalyzed=1`, {
    headers: { Authorization: `Bearer ${descriptor.token}` }
  });
  assert.equal(digest.status, 200);
  assert.match(digest.headers.get("content-type") ?? "", /^text\/markdown/u);
  assert.equal(await digest.text(), "_No recent activity recorded._");
} finally {
  await endpoint?.close();
  await assert.rejects(access(path.join(agentDir, "activity-api.json")), { code: "ENOENT" });
  await rm(agentDir, { recursive: true, force: true });
}
