import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("widget CLI 共用产物校验，支持文本、JSON 与保存页面", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-widget-cli-"));
  const htmlFile = path.join(root, "fragment.html");
  const out = path.join(root, "widget.html");
  const invoke = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"), "widget", ...args], { env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
  });
  try {
    await writeFile(htmlFile, '<output>4</output><script>window.square=x=>x*x</script>');
    const json = await invoke(["--html", htmlFile, "--title", "平方", "--out", out, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const artifact = JSON.parse(json.stdout);
    assert.equal(artifact.kind, "widget");
    assert.equal(artifact.title, "平方");
    assert.equal(await readFile(out, "utf8"), artifact.document);
    assert.match(artifact.document, /Content-Security-Policy/);
    const text = await invoke(["--html", htmlFile, "--title", "平方"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /<!doctype html>/);
    await writeFile(htmlFile, " ");
    const invalid = await invoke(["--html", htmlFile, "--title", "平方"]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Widget HTML is empty/);
    const missing = await invoke(["--html", htmlFile]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--title/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
