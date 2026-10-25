import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { videoAnalyzeCommand } from "../src/cli/commands/video.js";
import { attachmentRoot, saveAttachment } from "../src/attachments/store.js";
import { defaultConfig } from "../src/config/schema.js";

interface VideoServer {
  url: string;
  uploaded: Buffer[];
  analysisRequests: Array<{ url: string; body: Record<string, unknown>; apiKey?: string }>;
  deleted: number;
  failAnalysis: boolean;
  close(): Promise<void>;
}

async function startVideoServer(): Promise<VideoServer> {
  const state: VideoServer = {
    url: "",
    uploaded: [],
    analysisRequests: [],
    deleted: 0,
    failAnalysis: false,
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && request.url === "/upload/v1beta/files") {
        response.setHeader("x-goog-upload-url", `${state.url}/upload/session/one`);
        response.statusCode = 200;
        response.end();
      } else if (request.method === "POST" && request.url === "/upload/session/one") {
        state.uploaded.push(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ file: { name: "files/one", uri: "https://generativelanguage.googleapis.com/v1beta/files/one", mimeType: "video/mp4", state: "PROCESSING" } }));
      } else if (request.method === "GET" && request.url === "/v1beta/files/one") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ name: "files/one", state: "ACTIVE" }));
      } else if (request.method === "POST" && request.url === "/v1beta/models/gemini-2.5-flash:generateContent") {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { /* assertion catches malformed request */ }
        state.analysisRequests.push({ url: request.url, body: parsed, apiKey: request.headers["x-goog-api-key"]?.toString() });
        response.setHeader("content-type", "application/json");
        if (state.failAnalysis) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: { message: "unavailable" } }));
        } else {
          response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A person walks into a room." }] } }] }));
        }
      } else if (request.method === "DELETE" && request.url === "/v1beta/files/one") {
        state.deleted += 1;
        response.statusCode = 200;
        response.end("{}");
      } else {
        response.statusCode = 404;
        response.end("not found");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Video API test server failed to start.");
  state.url = `http://127.0.0.1:${address.port}`;
  return state;
}

function videoConfig(baseUrl: string) {
  const config = structuredClone(defaultConfig);
  config.providers.videoGemini = { type: "gemini", baseUrl: `${baseUrl}/v1beta/openai`, apiKey: "video-test-key" };
  config.models.videoGemini = { provider: "videoGemini", model: "gemini-2.5-flash" };
  config.defaultModel = "videoGemini";
  return config;
}

async function fixture(run: (root: string, server: VideoServer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-video-command-"));
  const server = await startVideoServer();
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try {
    await run(root, server);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("video analyze uploads a local file, requests native video analysis, and deletes the remote file", async () => {
  await fixture(async (root, server) => {
    const videoPath = path.join(root, "clip.mp4");
    const videoBytes = Buffer.from("sample video bytes");
    await writeFile(videoPath, videoBytes);
    const logs: string[] = [];
    const originalLog = console.log;
    const waits: number[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      await videoAnalyzeCommand(root, videoPath, "Describe the scene", { json: true }, {
        configStore: { load: async () => videoConfig(server.url) },
        fetcher: fetch,
        wait: async milliseconds => { waits.push(milliseconds); }
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(server.uploaded.length, 1);
    assert.deepEqual(server.uploaded[0], videoBytes);
    assert.equal(server.analysisRequests.length, 1);
    assert.equal(server.analysisRequests[0]?.apiKey, "video-test-key");
    assert.match(server.analysisRequests[0]?.url ?? "", /^\/v1beta\/models\/gemini-2\.5-flash/u);
    const contents = server.analysisRequests[0]?.body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.equal((contents[0]?.parts[0]?.file_data as Record<string, unknown>).mime_type, "video/mp4");
    assert.equal(contents[0]?.parts[1]?.text, "Describe the scene");
    assert.equal(server.deleted, 1);
    assert.deepEqual(waits, [2_000]);
    assert.deepEqual(JSON.parse(logs[0]!), { text: "A person walks into a room.", model: "videoGemini:gemini-2.5-flash" });
  });
});

test("video analyze accepts a stored @attachments reference and deletes the upload when analysis fails", async () => {
  await fixture(async (root, server) => {
    await mkdir(attachmentRoot(root), { recursive: true });
    const bytes = Buffer.from("telegram video bytes");
    const reference = await saveAttachment(root, "telegram-video.mp4", "video/mp4", bytes);
    server.failAnalysis = true;
    await assert.rejects(videoAnalyzeCommand(root, reference.path, "Summarize this clip", {}, {
      configStore: { load: async () => videoConfig(server.url) },
      fetcher: fetch,
      wait: async () => undefined
    }), /HTTP 503/u);
    assert.deepEqual(server.uploaded[0], bytes);
    assert.equal(server.deleted, 1);
  });
});

test("video analyze rejects unsupported files before contacting Gemini", async () => {
  await fixture(async (root, server) => {
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "not a video");
    await assert.rejects(videoAnalyzeCommand(root, filePath, "Summarize this" , {}, {
      configStore: { load: async () => videoConfig(server.url) },
      fetcher: fetch
    }), /Unsupported video format/u);
    assert.equal(server.uploaded.length, 0);
    assert.equal(server.analysisRequests.length, 0);
  });
});
