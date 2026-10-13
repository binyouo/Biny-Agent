import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "../src/acp/client.js";
import { acpConfigSchema } from "../src/acp/config.js";
import { runAcpTurn } from "../src/acp/turn.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";

// Existing session tests cover a single ordinary write; these requests exercise denied secondary paths and sensitive reads.
test("ACP checks every reported path and asks before reading credentials", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-policy-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  try {
    await writeFile(path.join(root, ".npmrc"), "fixture-only");
    await symlink(path.join(root, ".npmrc"), path.join(root, "credential-link"));
    for (const scenario of ["multipath", "credential", "symlink"]) {
      let confirmations = 0;
      for await (const event of runAcpTurn(client, { content: [{ type: "text", text: scenario }], model: "default", workspaceRoot: root, sessionId: "test",
        permissionManager: new PermissionManager({ mode: scenario === "multipath" ? "full-access" : "ask" }),
        confirmPermission: async () => { confirmations++; return { approved: false }; } })) {
        if (event.type === "done") { assert.equal(event.content, "no", scenario); assert.equal(event.outcome.status, "blocked"); }
      }
      assert.equal(confirmations, scenario === "multipath" ? 0 : 1);
    }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

// A buggy agent can finish its prompt while the user still sees an approval card.
test("ACP cancels an approval answered after its prompt has ended", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-late-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  let approve!: (value: import("@agentclientprotocol/sdk").RequestPermissionResponse) => void;
  try {
    await client.prompt({ content: [{ type: "text", text: "late" }], model: "default", onUpdate() {},
      onPermission: () => new Promise((resolve) => { approve = resolve; }) });
    approve({ outcome: { outcome: "selected", optionId: "yes" } });
    const { readFile } = await import("node:fs/promises");
    const { setTimeout } = await import("node:timers/promises");
    let response;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { response = JSON.parse(await readFile(path.join(root, "approval.json"), "utf8")); break; }
      catch { await setTimeout(10); }
    }
    assert.equal(response?.result?.outcome?.outcome, "cancelled");
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

// A terminal prompt response is not evidence that an already-started tool has finished.
test("ACP reports an incomplete turn when an external tool has no terminal result", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-unknown-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  try {
    let unknown = false;
    for await (const event of runAcpTurn(client, { content: [{ type: "text", text: "unknown" }], model: "default", workspaceRoot: root, sessionId: "test" })) {
      if (event.type === "tool.failed") unknown = event.executionStatus === "unknown";
      if (event.type === "done") { assert.equal(event.outcome.status, "incomplete"); assert.equal(event.outcome.stopReason, "missing_terminal_event"); }
    }
    assert.equal(unknown, true);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

// The launch environment must not expose unrelated provider credentials merely because Biny has them.
test("ACP inherits only runtime environment and explicitly mapped variables", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-env-"));
  const previous = process.env.BINY_ACP_AUDIT_SENTINEL;
  process.env.BINY_ACP_AUDIT_SENTINEL = "harmless-audit-marker";
  try {
    for (const explicit of [false, true]) {
      const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
        args: [path.resolve("tests/fixtures/acp-security-agent.mjs")], env: explicit ? { BINY_ACP_AUDIT_SENTINEL: "BINY_ACP_AUDIT_SENTINEL" } : {} }) });
      try {
        let output = "";
        await client.prompt({ content: [{ type: "text", text: "env" }], model: "default",
          onPermission: async () => ({ outcome: { outcome: "cancelled" } }), onUpdate: ({ update }) => {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") output += update.content.text;
          } });
        assert.equal(output, explicit ? "harmless-audit-marker" : "absent");
      } finally { await client.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.BINY_ACP_AUDIT_SENTINEL; else process.env.BINY_ACP_AUDIT_SENTINEL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// Runtime has a single approval card; concurrent protocol requests must not replace an unanswered card.
test("ACP serializes simultaneous permission requests without overwriting the pending approval", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-parallel-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  let active = 0, maximum = 0, count = 0;
  let release!: () => void;
  try {
    for await (const event of runAcpTurn(client, { content: [{ type: "text", text: "parallel" }], model: "default", workspaceRoot: root, sessionId: "test",
      permissionManager: new PermissionManager({ mode: "ask" }), signal: AbortSignal.timeout(3000),
      confirmPermission: async () => {
        active++; maximum = Math.max(maximum, active);
        if (++count === 1) await new Promise<void>((resolve) => { release = resolve; });
        active--; return { approved: false };
      } })) {
      if (event.type === "assistant.delta") release();
    }
    assert.equal(count, 2);
    assert.equal(maximum, 1);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP sensitive-file approval requires the explicit full confirmation", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-confirm-"));
  const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-security-agent.mjs")] }) });
  try {
    for (const confirmation of [undefined, "yes"]) {
      for await (const event of runAcpTurn(client, { content: [{ type: "text", text: "credential" }], model: "default", workspaceRoot: root, sessionId: "test",
        permissionManager: new PermissionManager({ mode: "ask" }), confirmPermission: async (request) => {
          assert.equal(request.requireFullYes, true);
          return { approved: true, confirmation };
        } })) {
        if (event.type === "done") assert.equal(event.content, confirmation === "yes" ? "yes" : "no");
      }
    }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
