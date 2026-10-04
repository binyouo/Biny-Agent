import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerComputerCommands } from "../src/cli/commands/computer.js";
import { ComputerAppApprovals } from "../src/computer/appApprovals.js";
import { createFileConfigStore } from "../src/config/store.js";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-cu-cli-"));
const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = root;
const log = console.log; const output: string[] = []; console.log = value => output.push(String(value));
const run = async (...args: string[]) => { const program = new Command(); registerComputerCommands(program); await program.parseAsync(["node", "biny", "computer", ...args]); };
try {
  const policy = new ComputerAppApprovals(createFileConfigStore(process.cwd()));
  await policy.authorize({ bundleId: "test.notes", appName: "Notes" });
  await run("strict", "on", "--json"); assert.equal(JSON.parse(output.at(-1)!).strictApproval, true);
  await run("revoke", "test.notes", "--json"); assert.ok(JSON.parse(output.at(-1)!).apps[0].revokedAt);
  await run("approve", "test.notes", "--json"); assert.equal(JSON.parse(output.at(-1)!).apps[0].revokedAt, undefined);
  await run("status"); assert.match(output.at(-1)!, /test.notes.*approved/);
  await assert.rejects(run("strict", "maybe"), /on or off/);
  await assert.rejects(run("approve", "unknown.app"), /unknown_app/);
} finally { console.log = log; if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
console.log("computer approval CLI tests passed");
