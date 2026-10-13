import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "../src/acp/client.js";
import { acpConfigSchema } from "../src/config/schema.js";

test("missing ACP executable explains installation and PATH recovery instead of a generic startup failure", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-missing-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: path.join(root, "not-installed") }) });
  try {
    await assert.rejects(client.connect(), /安装.*高级设置.*绝对路径/u);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP reads modern model and mode config options and uses their advertised IDs", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-client-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-agent.mjs"), "--config-options"], modeId: "ask" }) });
  try {
    const info = await client.connect();
    assert.deepEqual(info.models, [{ id: "test", name: "Test model" }, { id: "second", name: "Second model" }]);
    assert.deepEqual(info.modes, [{ id: "ask", name: "Ask" }]);
    assert.equal(await client.prompt({ content: [{ type: "text", text: "hello" }], model: "second",
      onUpdate() {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), "end_turn");
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.filter((r) => r.method === "session/set_config_option").map((r) => r.params), [
      { sessionId: "fixture-session", configId: "execution", value: "ask" },
      { sessionId: "fixture-session", configId: "llm", value: "second" }
    ]);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP bounded startup and cancellation release hung child processes", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-stop-"));
  const hanging = new AcpClient({ cwd: root, timeoutMs: 100, launch: acpConfigSchema.parse({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }) });
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs"), "--ignore-cancel"] }) });
  try {
    await assert.rejects(hanging.connect());
    const controller = new AbortController();
    await assert.rejects(client.prompt({ content: [{ type: "text", text: "wait-fixture" }], model: "default", signal: controller.signal,
      onUpdate: () => controller.abort(), onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }));
    assert.equal(await client.prompt({ content: [{ type: "text", text: "hello" }], model: "default",
      onUpdate() {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), "end_turn", "new connection works after forced process cleanup");
  } finally { await hanging.close(); await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP persisted sessions load without prompt replay and configuration changes cannot attach to old sessions", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-binding-"));
  const options = { cwd: root, bindingFile: path.join(root, "binding.json"), launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] }) };
  let client = new AcpClient(options);
  try {
    await client.connect();
    await client.close();
    client = new AcpClient(options);
    assert.equal((await client.connect()).sessionId, "fixture-session");
    await client.close();
    client = new AcpClient({ ...options, launch: { ...options.launch, args: [...options.launch.args, "changed"] } });
    await assert.rejects(client.connect(), /配置已变化/u);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP credential reference rotation cannot resume a session belonging to the previous environment", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-identity-"));
  const previous = process.env.ACP_TEST_ACCOUNT;
  const options = { cwd: root, bindingFile: path.join(root, "binding.json"), launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-agent.mjs")], env: { ACCOUNT: "ACP_TEST_ACCOUNT" } }) };
  let client = new AcpClient(options);
  try {
    process.env.ACP_TEST_ACCOUNT = "first-fixture-account";
    await client.connect();
    await client.close();
    process.env.ACP_TEST_ACCOUNT = "second-fixture-account";
    client = new AcpClient(options);
    await assert.rejects(client.connect(), /配置已变化/u);
    assert.doesNotMatch(await readFile(options.bindingFile, "utf8"), /fixture-account/u);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.ACP_TEST_ACCOUNT; else process.env.ACP_TEST_ACCOUNT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP startup errors retain bounded diagnostics without mapped credentials", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-diagnostics-"));
  const previous = process.env.ACP_TEST_SECRET;
  process.env.ACP_TEST_SECRET = "unprefixed-fixture-credential";
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
    args: ["-e", "process.stderr.write('Missing adapter dependency '+process.env.SECRET);process.exit(7)"], env: { SECRET: "ACP_TEST_SECRET" } }) });
  try {
    await assert.rejects(client.connect(), (error: Error) => {
      assert.match(error.message, /Missing adapter dependency/u);
      assert.doesNotMatch(error.message, /unprefixed-fixture-credential/u);
      assert.ok(error.message.length < 9000);
      return true;
    });
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.ACP_TEST_SECRET; else process.env.ACP_TEST_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP enforces a prompt deadline even when the process remains alive", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-deadline-"));
  const launch = { ...acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] }), promptTimeoutMs: 100 };
  const client = new AcpClient({ cwd: root, launch });
  try {
    await assert.rejects(client.prompt({ content: [{ type: "text", text: "wait-fixture" }], model: "default", signal: AbortSignal.timeout(2000),
      onUpdate() {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), /超时/u);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP rejects oversized protocol output before accumulating it into session events", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-output-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-security-agent.mjs")], maxOutputBytes: 1024 }) });
  try {
    await assert.rejects(client.prompt({ content: [{ type: "text", text: "flood" }], model: "default",
      onUpdate() {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), /输出.*上限/u);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP startup diagnostics also redact credentials delegated with MCP connections", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-mcp-secret-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-agent.mjs"), "--fail-mcp"] }),
    mcpServers: [{ name: "fixture", command: "unused", args: [], env: [{ name: "TOKEN", value: "unprefixed-mcp-credential" }] }] });
  try {
    await assert.rejects(client.connect(), (error: Error) => {
      assert.match(error.message, /MCP authentication failed/u);
      assert.doesNotMatch(error.message, /unprefixed-mcp-credential/u);
      return true;
    });
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP rejects a single oversized frame even below the total turn output budget", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-frame-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  try {
    let emitted = false;
    await assert.rejects(client.prompt({ content: [{ type: "text", text: "large-frame" }], model: "default",
      onUpdate() { emitted = true; }, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }));
    assert.equal(emitted, false, "an oversized frame must not enter the event queue");
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
