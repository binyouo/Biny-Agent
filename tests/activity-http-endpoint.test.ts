/** Desktop Activity HTTP 入口的发现文件、无认证访问和关闭清理。 */
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
  assert.equal(descriptor.token, undefined);
  assert.equal((await stat(discoveryPath)).mode & 0o777, 0o600);

  const url = `http://${descriptor.host}:${descriptor.port}/api/activity-recorder/config`;
  assert.equal((await fetch(url)).status, 200);
  const authorized = await fetch(url, { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json() as { enabled: boolean }).enabled, false);
} finally {
  await endpoint?.close();
  await assert.rejects(access(path.join(agentDir, "activity-api.json")), { code: "ENOENT" });
  await rm(agentDir, { recursive: true, force: true });
}
