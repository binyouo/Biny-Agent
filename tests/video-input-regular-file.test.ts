import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { videoAnalyzeCommand } from "../src/cli/commands/video.js";
import { defaultConfig } from "../src/config/schema.js";

interface ProbeResult {
  ready?: boolean;
  timedOut?: boolean;
  error?: string;
  requests?: number;
  uploaded?: string;
  logs?: string[];
  fdsBefore?: number;
  fdsAfter?: number;
}

async function descriptorCount(root: string): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  const targets = await Promise.all((await readdir("/proc/self/fd")).map(async fd => {
    try { return await readlink(`/proc/self/fd/${fd}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  // Loader/background descriptors can close during a command. Inspect only the
  // real descriptors pointing at this fixture's own temporary input directory.
  return targets.filter(target => target === root || target?.startsWith(`${root}${path.sep}`)).length;
}

async function probe(file: string, mode: string): Promise<void> {
  const config = structuredClone(defaultConfig);
  config.providers = { video: { type: "gemini", apiKey: "synthetic-video-key", baseUrl: "https://unused.invalid/v1beta" } };
  config.models = { video: { provider: "video", model: "gemini-2.5-flash" } };
  config.defaultModel = "video";
  let requests = 0;
  let uploaded: string | undefined;
  const logs: string[] = [];
  const originalLog = console.log;
  const fdsBefore = await descriptorCount(path.dirname(file));
  process.send?.({ ready: true });
  console.log = (...values: unknown[]) => { logs.push(values.join(" ")); };
  let error: string | undefined;
  try {
    await videoAnalyzeCommand(path.dirname(file), file, mode === "blank" ? " " : "Describe the clip", { json: true }, {
      configStore: { load: async () => config },
      fetcher: async (_url, init) => {
        requests += 1;
        if (mode === "upstream-failure") throw new Error("synthetic upstream failure");
        if (requests === 1) return new Response(null, { headers: { "x-goog-upload-url": "https://unused.invalid/upload" } });
        if (requests === 2) {
          uploaded = Buffer.from(await new Response(init?.body).arrayBuffer()).toString("utf8");
          return Response.json({ file: { name: "files/synthetic", uri: "https://unused.invalid/file", mimeType: "video/mp4", state: "ACTIVE" } });
        }
        if (requests === 3) return Response.json({ candidates: [{ content: { parts: [{ text: "synthetic analysis" }] } }] });
        assert.equal(init?.method, "DELETE");
        return Response.json({});
      }
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    console.log = originalLog;
  }
  process.send?.({ error, requests, uploaded, logs, fdsBefore, fdsAfter: await descriptorCount(path.dirname(file)) });
  process.disconnect?.();
}

async function runProbe(file: string, mode = "ordinary"): Promise<ProbeResult> {
  return await new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--video-input-probe", file, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    let result: ProbeResult | undefined;
    let timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Video probe did not initialize.")); }, 30_000);
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.on("message", (message: ProbeResult) => {
      clearTimeout(timer);
      if (message.ready) {
        timer = setTimeout(() => { result = { timedOut: true }; child.kill("SIGKILL"); }, 3_000);
      } else result = message;
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (result && (code === 0 || result.timedOut)) resolve(result);
      else reject(new Error(`Video probe exited ${String(code)}: ${stderr}`));
    });
  });
}

if (process.argv[2] === "--video-input-probe") {
  await probe(process.argv[3]!, process.argv[4]!);
} else {
  test("video local input rejects unsupported entries without blocking or changing regular-file upload", async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-video-regular-input-"));
    try {
      const file = path.join(root, "clip with spaces.mp4");
      await writeFile(file, "synthetic-video-bytes");
      await writeFile(path.join(root, "empty.mp4"), "");
      await writeFile(path.join(root, "notes.txt"), "not video");
      await mkdir(path.join(root, "directory.mp4"));
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [path.join(root, "pipe.mp4")]);
        await symlink(file, path.join(root, "alias.mp4"));
      }
      await t.test("descriptor probe detects an actually open input", { skip: process.platform !== "linux" }, async () => {
        assert.equal(await descriptorCount(root), 0);
        const handle = await open(file, "r");
        try { assert.equal(await descriptorCount(root), 1); }
        finally { await handle.close(); }
        assert.equal(await descriptorCount(root), 0);
      });
      const rejected = async (name: string, pattern: RegExp, mode?: string) => {
        const result = await runProbe(path.join(root, name), mode);
        assert.equal(result.timedOut, undefined, "input must settle without waiting for a FIFO writer");
        assert.match(result.error ?? "", pattern);
        assert.equal(result.requests, 0);
        assert.equal(result.fdsAfter, result.fdsBefore);
      };
      await t.test("FIFO is rejected before upload", { skip: process.platform === "win32" }, async () => {
        await rejected("pipe.mp4", /regular file/u);
      });
      await t.test("regular file uploads unchanged bytes and cleans up", async () => {
        const result = await runProbe(file);
        assert.equal(result.timedOut, undefined);
        assert.equal(result.error, undefined);
        assert.equal(result.uploaded, "synthetic-video-bytes");
        assert.equal(result.requests, 4);
        assert.deepEqual(JSON.parse(result.logs![0]!), { text: "synthetic analysis", model: "video:gemini-2.5-flash" });
        assert.equal(result.fdsAfter, result.fdsBefore);
      });
      await t.test("upload startup failure closes the file", async () => {
        const result = await runProbe(file, "upstream-failure");
        assert.match(result.error ?? "", /synthetic upstream failure/u);
        assert.equal(result.requests, 1);
        assert.equal(result.fdsAfter, result.fdsBefore);
      });
      await t.test("empty file", async () => { await rejected("empty.mp4", /empty/u); });
      await t.test("directory", async () => { await rejected("directory.mp4", /regular file/u); });
      await t.test("symlink", { skip: process.platform === "win32" }, async () => { await rejected("alias.mp4", /ELOOP|EMLINK/u); });
      await t.test("missing file", async () => { await rejected("missing.mp4", /ENOENT/u); });
      await t.test("unsupported extension", async () => { await rejected("notes.txt", /Unsupported video format/u); });
      await t.test("blank prompt fails before opening", async () => { await rejected(process.platform === "win32" ? "missing.mp4" : "pipe.mp4", /prompt must not be empty/u, "blank"); });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
