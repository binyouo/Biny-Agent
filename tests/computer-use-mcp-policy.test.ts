import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ComputerAppApprovals } from "../src/computer/appApprovals.js";
import { ComputerAuditStore } from "../src/computer/auditStore.js";
import { LocalComputerMcpPolicy } from "../src/computer/mcpPolicy.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";

test("external MCP uses persistent application approval, refuses disabled control, and logs metadata across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-policy-"));
  const store = createFileConfigStore(root, { globalDir: root });
  const journal = new ComputerAuditStore(path.join(root, "actions.sqlite")); let dispatched = 0, notices = 0;
  const driver = new NativeProcessDriver(() => undefined);
  driver.list = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.notes", name: "Notes", running: true }] }, images: [] });
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 42, bundleId: "test.notes", elements: [] }, images: [] });
  driver.actRaw = async (_cmd, args, pid) => { dispatched++; assert.equal(pid, 12); assert.equal(args.window_id, 42); return { data: { typed: 1 }, images: [] }; };
  driver.capturePreview = async () => ({ data: {}, images: [] });
  const policy = new LocalComputerMcpPolicy(driver, store, journal, async () => { notices++; });
  const server = createComputerUseMcpServer(driver, policy); const client = new Client({ name: "policy-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await updateConfig(store, undefined, () => configSchema.parse({ ...defaultConfig, computer: { enabled: true, strictApproval: true, actionLogging: true, apps: [] } }));
    await Promise.all([server.connect(right), client.connect(left)]);
    const denied = await client.callTool({ name: "get_app_state", arguments: { pid: 12, window_id: 42 } }); assert.equal(denied.isError, true);
    assert.equal((await store.load()).computer.apps[0]?.approvedAt, undefined);
    await new ComputerAppApprovals(store).approve("test.notes");
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 12, window_id: 42 } })).isError, true);
    await client.callTool({ name: "type_text", arguments: { pid: 12, ref: "private-ref", text: "private-input" } });
    assert.equal(dispatched, 1); assert.equal(notices, 1);
    await updateConfig(store, undefined, config => ({ ...config, computer: { ...config.computer, enabled: false } }));
    assert.equal((await client.callTool({ name: "type_text", arguments: { pid: 12, text: "must-not-dispatch" } })).isError, true); assert.equal(dispatched, 1);
    journal.close(); const reopened = new ComputerAuditStore(path.join(root, "actions.sqlite"));
    try { const records = reopened.recent(); assert.equal(records.length, 1); assert.equal(records[0]?.bundleId, "test.notes"); assert.doesNotMatch(JSON.stringify(records), /private|input|ref|image/); } finally { reopened.close(); }
  } finally { await client.close(); await server.close(); journal.close(); await driver.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("a not-recent installed application is identified and authorized before launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-launch-"));
  const store = createFileConfigStore(root, { globalDir: root }); const journal = new ComputerAuditStore();
  const driver = new NativeProcessDriver(() => undefined); let launches = 0;
  driver.list = async () => ({ data: { apps: [] }, images: [] });
  driver.daemonCommand = async (command, args) => { assert.equal(command, "app_identity"); assert.equal(args?.bundle, "test.installed"); return { data: { bundleId: "test.installed", name: "Installed", running: false }, images: [] }; };
  const policy = new LocalComputerMcpPolicy(driver, store, journal, async () => undefined);
  try {
    await updateConfig(store, undefined, config => ({ ...config, computer: { ...config.computer, enabled: true, strictApproval: true } }));
    await assert.rejects(policy.run("launch_app", { bundle: "test.installed" }, async () => { launches++; return { content: [] }; }), /approval_required/);
    assert.equal(launches, 0); await new ComputerAppApprovals(store).approve("test.installed");
    await policy.run("launch_app", { bundle: "test.installed" }, async () => { launches++; return { content: [] }; });
    assert.equal(launches, 1);
  } finally { await policy.close(); await driver.dispose(); await rm(root, { recursive: true, force: true }); }
});
