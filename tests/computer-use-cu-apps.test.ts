import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerCuCommands } from "../src/cli/commands/cu.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

test("CLI application lists expose foreground state and system usage counts while preserving JSON", async context => {
  const apps = [
    { pid: 12, bundleId: "test.front", name: "Front", running: true, active: true, useCount: 5 },
    { pid: 13, bundleId: "test.back", name: "Back", running: true, active: false, useCount: 0 },
    { bundleId: "test.recent", name: "Recent", running: false, lastUsed: "2026-10-27T00:00:00Z" }
  ];
  const output: string[] = [], requests: unknown[] = [];
  context.mock.method(console, "log", (value: string) => { output.push(value); });
  context.mock.method(NativeProcessDriver.prototype, "daemonCommand", async (command: string, args: Record<string, unknown>) => {
    requests.push({ command, args });
    return { data: { apps: args.recent_days === 0 ? apps.slice(0, 2) : apps }, images: [] };
  });
  const run = async (...args: string[]) => {
    const command = new Command().exitOverride();
    registerCuCommands(command); await command.parseAsync(["node", "biny", "cu", ...args]);
  };
  await run("list_apps");
  const lines = output[0]!.split("\n");
  assert.match(lines[0]!, /^\* .*test\.front.*Front.*\(5×\)/u);
  assert.match(lines[1]!, /^R .*test\.back.*Back.*\(0×\)/u);
  assert.match(lines[2]!, /^ {2}.*test\.recent.*Recent.*2026-10-27/u);
  assert.doesNotMatch(lines[2]!, /×/u, "missing frequency stays unknown");
  await run("list_apps", "--json");
  assert.deepEqual(JSON.parse(output[1]!), apps);
  await run("apps");
  assert.equal(output[2]!.split("\n").length, 2);
  assert.match(output[2]!, /^\* .*Front/u);
  assert.deepEqual(requests, [
    { command: "list_apps", args: { recent_days: 14 } },
    { command: "list_apps", args: { recent_days: 14 } },
    { command: "list_apps", args: { recent_days: 0 } }
  ]);
});
