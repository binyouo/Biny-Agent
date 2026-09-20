import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-local-capabilities-cli-"));
const agentRoot = path.join(root, "agent");
const cli = path.resolve("src/cli/index.ts");

try {
  const taskHelp = await runCli(["task", "--help"]);
  assert.equal(taskHelp.code, 0);
  assert.match(taskHelp.stdout, /start \[options\] <taskRunId>/u);
  assert.match(taskHelp.stdout, /run \[options\] <taskRunId>/u);

  const automationHelp = await runCli(["automation", "--help"]);
  assert.equal(automationHelp.code, 0);
  assert.match(automationHelp.stdout, /pending \[options\]/u);

  const goalHelp = await runCli(["goal", "--help"]);
  assert.equal(goalHelp.code, 0);
  assert.match(goalHelp.stdout, /list \[options\]/u);

  const graphHelp = await runCli(["graph", "--help"]);
  assert.equal(graphHelp.code, 0);
  assert.match(graphHelp.stdout, /list \[options\]/u);

  const skillHelp = await runCli(["skill", "--help"]);
  assert.equal(skillHelp.code, 0);
  assert.match(skillHelp.stdout, /search\|find \[options\]/u);
  assert.match(skillHelp.stdout, /install <source>/u);
  assert.match(skillHelp.stdout, /update/u);
  assert.match(skillHelp.stdout, /uninstall <name>/u);

  const skillFile = path.join(root, "created-skill.md");
  await writeFile(skillFile, "---\nname: cli-created-skill\ndescription: Created by the CLI test\n---\n\n# Test\n");
  const skillCreate = await runCli(["skill", "create", "cli-created-skill", "--file", skillFile]);
  assert.equal(skillCreate.code, 0);
  await access(path.join(agentRoot, "skills", "cli-created-skill", "SKILL.md"));

  const skillList = await runCli(["skill", "list", "--json"]);
  assert.equal(skillList.code, 0);
  assert.equal(JSON.parse(skillList.stdout).skills.some((skill: { name: string }) => skill.name === "cli-created-skill"), true);

  const skillUninstall = await runCli(["skill", "uninstall", "cli-created-skill"]);
  assert.equal(skillUninstall.code, 0);
  await assert.rejects(() => access(path.join(agentRoot, "skills", "cli-created-skill")));

  const memoryHelp = await runCli(["memory", "--help"]);
  assert.equal(memoryHelp.code, 0);
  assert.match(memoryHelp.stdout, /search \[options\] <query\.\.\.>/u);
  assert.match(memoryHelp.stdout, /sleep \[options\]/u);

  const reflectionHelp = await runCli(["reflection", "--help"]);
  assert.equal(reflectionHelp.code, 0);
  assert.match(reflectionHelp.stdout, /status \[options\]/u);
  assert.match(reflectionHelp.stdout, /run \[options\]/u);

  const archiveWithoutConfirmation = await runCli(["memory", "archive-entry", "memory-id"]);
  assert.equal(archiveWithoutConfirmation.code, 1);
  assert.match(archiveWithoutConfirmation.stderr, /required option '--yes' not specified/u);

  const todoWithoutConfirmation = await runCli(["todo", "clear"]);
  assert.equal(todoWithoutConfirmation.code, 1);
  assert.match(todoWithoutConfirmation.stderr, /required option '--yes' not specified/u);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: agentRoot }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return await new Promise<CliResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

console.log("local capabilities CLI tests passed");
