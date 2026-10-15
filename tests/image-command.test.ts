/**
 * `biny image` 命令测试：模型解析、宽高比映射与 provider 路由，用隔离配置与
 * 本地 stub 服务验证，不调用真实生图 API。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { imageEditCommand, imageGenerateCommand, imageModelsCommand } from "../src/cli/commands/image.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";

const outputPaths = new Set<string>();
async function cleanupOutputs(): Promise<void> {
  for (const file of outputPaths) {
    if (path.dirname(file).startsWith(path.join(os.tmpdir(), "biny-image-gen-"))) await rm(path.dirname(file), { recursive: true, force: true });
  }
  outputPaths.clear();
}
const testCredentials = new Map<string, string>();
const testCredentialStore = {
  persistent: true,
  get: async (account: string) => testCredentials.get(account),
  set: async (account: string, value: string) => { testCredentials.set(account, value); },
  delete: async (account: string) => { testCredentials.delete(account); }
};

async function fixture(run: (root: string, server: StubServer, configStore: ReturnType<typeof createFileConfigStore>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-image-cmd-"));
  const server = await startStubServer();
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "agent-state"), credentialStore: testCredentialStore });
  try {
    await mkdir(path.join(root, ".biny"), { recursive: true });
    await writeConfig(configStore, server);
    await run(root, server, configStore);
  } finally {
    await server.close();
    await cleanupOutputs();
    await rm(root, { recursive: true, force: true });
  }
}

interface StubServer {
  url: string;
  requests: Array<{ url: string; body: unknown; headers: import("node:http").IncomingHttpHeaders }>;
  responses: Map<string, { status?: number; body: unknown }>;
  close(): Promise<void>;
}

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function startStubServer(): Promise<StubServer> {
  const requests: StubServer["requests"] = [];
  const responses: StubServer["responses"] = new Map();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body: raw ? safeJson(raw) : undefined, headers: req.headers });
      const override = responses.get(req.url ?? "") ?? responses.get((req.url ?? "").split("?")[0]!);
      if (override) { res.statusCode = override.status ?? 200; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(override.body)); return; }
      if (req.url?.split("?")[0] === "/v1beta/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          models: [
            { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
            { name: "models/nano-banana", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] }
          ]
        }));
        return;
      }
      if (req.url?.includes(":generateContent")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PIXEL_PNG.toString("base64") } }] } }]
        }));
        return;
      }
      if (req.url === "/v1/images/generations") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: PIXEL_PNG.toString("base64") }] }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests, responses,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

async function writeConfig(configStore: ReturnType<typeof createFileConfigStore>, server: StubServer, options: { imageModel?: string } = {}): Promise<void> {
  const config = {
    ...defaultConfig,
    defaultModel: "test",
    providers: {
      gem: {
        type: "gemini" as const,
        baseUrl: `${server.url}/v1beta/openai`,
        apiKey: "stub-gemini-key"
      },
      oai: {
        type: "openai" as const,
        baseUrl: `${server.url}/v1`,
        apiKey: "stub-openai-key"
      }
    },
    models: { test: { provider: "gem", model: "gemini-2.5-flash" } },
    imageGen: { model: options.imageModel, aspectRatio: undefined }
  };
  await configStore.save(config as Parameters<typeof configStore.save>[0]);
}

function captureStdout(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  return run()
    .then(() => {
      for (const line of out) {
        if (line.startsWith(os.tmpdir())) outputPaths.add(line);
        else { try { const result = JSON.parse(line); if (typeof result.path === "string") outputPaths.add(result.path); } catch { /* Non-JSON output. */ } }
      }
      return { stdout: out.join("\n"), stderr: err.join("\n") };
    })
    .finally(() => { console.log = oldLog; console.error = oldError; });
}

async function main(): Promise<void> {
  await fixture(async (root, _server, configStore) => {
    const { stdout } = await captureStdout(() => imageModelsCommand(root, { json: true, configStore }));
    const parsed = JSON.parse(stdout) as { models: Array<{ value: string }>; best?: string; default?: string };
    assert.ok(parsed.models.some((m) => m.value.includes("nano-banana")));
  });

  await fixture(async (root, server, configStore) => {
    const { stdout } = await captureStdout(() => imageGenerateCommand(root, "a small cat", { configStore }));
    const outPath = stdout.trim();
    assert.ok(outPath.endsWith(".png"), `expected a png path, got ${outPath}`);
    const call = server.requests.find((r) => r.url.includes(":generateContent"));
    assert.ok(call, "expected a Gemini generateContent request");
    const body = call.body as { contents: Array<{ parts: Array<{ text?: string }> }> };
    assert.equal(body.contents[0]?.parts.some((p) => p.text === "a small cat"), true);
  });

  await fixture(async (root, server, configStore) => {
    await captureStdout(() => imageGenerateCommand(root, "wide banner", { aspect: "16:9", configStore }));
    const call = server.requests.find((r) => r.url.includes(":generateContent"));
    const body = call?.body as { generationConfig?: { imageConfig?: { aspectRatio?: string } } };
    assert.equal(body.generationConfig?.imageConfig?.aspectRatio, "16:9");
  });

  await fixture(async (root, server, configStore) => {
    const editPath = path.join(root, "source.png");
    await writeFile(editPath, PIXEL_PNG);
    await captureStdout(() => imageEditCommand(root, editPath, "make the background blue", { configStore }));
    const call = server.requests.find((r) => r.url.includes(":generateContent"));
    const body = call?.body as { contents: Array<{ parts: Array<{ inlineData?: unknown; text?: string }> }> };
    assert.equal(body.contents[0]?.parts.some((p) => p.inlineData !== undefined), true);
    assert.equal(body.contents[0]?.parts.some((p) => p.text === "make the background blue"), true);
  });

  // 显式 providerAlias:modelId 路由到 OpenAI 兼容 provider，而不是 Gemini。
  await fixture(async (root, server, configStore) => {
    const { stderr } = await captureStdout(() => imageGenerateCommand(root, "an abstract poster", { model: "oai:gpt-image-1", configStore }));
    assert.match(stderr, /oai:gpt-image-1/);
    const openAiCall = server.requests.find((r) => r.url === "/v1/images/generations");
    assert.ok(openAiCall, "expected an OpenAI-compatible generations request");
    assert.equal(server.requests.some((r) => r.url.includes(":generateContent") && r.url.includes("gpt-image-1")), false);
  });

  // 配置的 imageGen.model 作为默认模型生效。
  const root2 = await mkdtemp(path.join(os.tmpdir(), "biny-image-cfg-"));
  const server2 = await startStubServer();
  const configStore2 = createFileConfigStore(root2, { globalDir: path.join(root2, "agent-state"), credentialStore: testCredentialStore });
  try {
    await writeConfig(configStore2, server2, { imageModel: "gem:gemini-2.0-flash" });
    await captureStdout(() => imageGenerateCommand(root2, "a configured default", { configStore: configStore2 }));
    const call = server2.requests.find((r) => r.url.includes("gemini-2.0-flash:generateContent"));
    assert.ok(call, "expected the configured model to be used");
  } finally {
    await server2.close();
    await cleanupOutputs();
    await rm(root2, { recursive: true, force: true });
  }

  console.log("image command tests passed");
}

await main();


for (const model of ["missing:image", "gem:gemini-2.5-flash-image"]) await test(`配置模型 ${model} 失效时拒绝替换，停用 Provider 不发请求`, async () => {
  await fixture(async (root, server, configStore) => {
    const config = await configStore.load();
    config.imageGen.model = model;
    config.providers.gem!.enabled = false;
    await configStore.save(config);
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore })), /Unknown provider|disabled/u);
    assert.equal(server.requests.length, 0);
  });
});

await test("自动选择跳过停用的 Gemini，模型列表的默认值与实际选择一致", async () => {
  await fixture(async (root, server, configStore) => {
    const listed = JSON.parse((await captureStdout(() => imageModelsCommand(root, { configStore, json: true }))).stdout);
    assert.equal(listed.best, "gem:nano-banana");
    assert.equal(listed.default, "gem:nano-banana");
    server.requests.length = 0;
    const config = await configStore.load(); config.providers.gem!.enabled = false; await configStore.save(config);
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore })), /No.*provider/iu);
    assert.equal(server.requests.length, 0);
  });
});

await test("参考图不存在时不降级为纯文字生图，相对路径从工作区读取", async () => {
  await fixture(async (root, server, configStore) => {
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "oai:gpt-image-1", reference: ["missing.png"] })), /ENOENT|not found/u);
    assert.equal(server.requests.length, 0);
    await writeFile(path.join(root, "reference.png"), PIXEL_PNG);
    server.responses.set("/v1/images/edits", { body: { data: [{ b64_json: PIXEL_PNG.toString("base64") }] } });
    const result = await captureStdout(() => imageGenerateCommand(root, "edit this", { configStore, model: "oai:gpt-image-1", reference: ["reference.png"] }));
    assert.ok(server.requests.some(request => request.url === "/v1/images/edits"));
    assert.deepEqual(await readFile(result.stdout.trim()), PIXEL_PNG);
  });
});

await test("API HTTP 失败保留状态并脱敏，不把错误响应当作图片", async () => {
  await fixture(async (root, server, configStore) => {
    server.responses.set("/v1beta/models/gemini-2.5-flash-image:generateContent", { status: 429, body: { message: "token stub-gemini-key" } });
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "gem:gemini-2.5-flash-image" })), error => {
      assert.match(String(error), /429/u); assert.doesNotMatch(String(error), /stub-gemini-key/u); return true;
    });
  });
});

await test("同一毫秒产生的图片使用独立文件，OpenRouter 图片请求与输出保持真实格式", async () => {
  await fixture(async (root, server, configStore) => {
    const config = await configStore.load(); config.providers.router = { type: "openrouter", baseUrl: `${server.url}/v1`, apiKey: "stub-router-key" }; await configStore.save(config);
    server.responses.set("/v1/images", { body: { data: [{ b64_json: PIXEL_PNG.toString("base64"), media_type: "image/png" }] } });
    const now = Date.now; Date.now = () => 1770000000000;
    try {
      const first = await captureStdout(() => imageGenerateCommand(root, "one", { configStore, model: "router:openai/gpt-image-1", aspect: "16:9" }));
      const second = await captureStdout(() => imageGenerateCommand(root, "two", { configStore, model: "router:openai/gpt-image-1" }));
      assert.notEqual(first.stdout, second.stdout);
      assert.deepEqual(await readFile(first.stdout.trim()), PIXEL_PNG);
      const request = server.requests.find(request => request.url === "/v1/images")!;
      assert.deepEqual(request.body, { model: "openai/gpt-image-1", prompt: "one", aspect_ratio: "16:9" });
    } finally { Date.now = now; }
  });
});


await test("请求凭据只在头部发送，超时使用 Provider 配置且不重试生成", async t => {
  await fixture(async (root, server, configStore) => {
    const result = await captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "gem:gemini-2.5-flash-image", json: true }));
    assert.deepEqual(await readFile(JSON.parse(result.stdout).path), PIXEL_PNG);
    const call = server.requests[0]!;
    assert.equal(call.headers["x-goog-api-key"], "stub-gemini-key");
    assert.doesNotMatch(call.url, /key=|stub-gemini-key/u);
    const config = await configStore.load(); config.providers.gem!.timeoutMs = 1234; await configStore.save(config);
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (timeout: number) => { timeouts.push(timeout); return AbortSignal.abort(new DOMException("synthetic deadline", "TimeoutError")); });
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "gem:gemini-2.5-flash-image" })), /TimeoutError/u);
    assert.deepEqual(timeouts, [1234]);
    assert.equal(server.requests.length, 1, "失败后不自动重试计费请求");
  });
});

await test("非法宽高比、空图片和非法返回数据显式失败", async () => {
  await fixture(async (root, server, configStore) => {
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "oai:gpt-image-1", aspect: "0:0" })), /aspect ratio/u);
    const empty = path.join(root, "empty.png"); await writeFile(empty, "");
    await assert.rejects(captureStdout(() => imageEditCommand(root, empty, "a cat", { configStore, model: "oai:gpt-image-1" })), /empty/u);
    assert.equal(server.requests.length, 0);
    server.responses.set("/v1/images/generations", { body: { data: [{ b64_json: "not base64!" }] } });
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "oai:gpt-image-1" })), /base64/u);
    server.responses.set("/v1/images/generations", { body: { data: [{ b64_json: PIXEL_PNG.toString("base64"), media_type: "image/../../escape" }] } });
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "oai:gpt-image-1" })), /Invalid.*image/u);
  });
});


await test("模型目录完整读取分页并报告服务商错误，OpenRouter 使用图片模型目录", async () => {
  await fixture(async (root, server, configStore) => {
    server.responses.set("/v1beta/models", { body: { models: [], nextPageToken: "next" } });
    server.responses.set("/v1beta/models?pageToken=next", { body: { models: [{ name: "models/nano-banana", supportedGenerationMethods: ["generateContent"] }] } });
    const config = await configStore.load(); config.providers.router = { type: "openrouter", baseUrl: `${server.url}/v1`, apiKey: "stub-router-key" }; await configStore.save(config);
    server.responses.set("/v1/images/models", { body: { data: [{ id: "openai/gpt-image-1", name: "GPT Image" }] } });
    const listed = JSON.parse((await captureStdout(() => imageModelsCommand(root, { configStore, json: true }))).stdout);
    assert.equal(listed.default, "gem:nano-banana");
    assert.ok(listed.models.some((model: { value: string }) => model.value === "router:openai/gpt-image-1"));
    server.responses.set("/v1beta/models", { status: 401, body: { error: "stub-gemini-key invalid" } });
    const partial = JSON.parse((await captureStdout(() => imageModelsCommand(root, { configStore, json: true }))).stdout);
    assert.match(partial.errors[0].message, /401/u);
    assert.doesNotMatch(partial.errors[0].message, /stub-gemini-key/u);
    assert.equal(partial.best, undefined);
  });
});

await test("损坏 JSON 不泄露原始响应或凭据", async t => {
  await fixture(async (root, _server, configStore) => {
    t.mock.method(globalThis, "fetch", async () => new Response("stub-openai-key: broken JSON", { status: 200 }));
    await assert.rejects(captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "oai:gpt-image-1" })), error => {
      assert.match(String(error), /JSON/u); assert.doesNotMatch(String(error), /stub-openai-key/u); return true;
    });
  });
});

await test("CLI 注册图片命令，配置默认值和 JSON 输出可从公开入口使用", async () => {
  await fixture(async (root, server, configStore) => {
    const config = await configStore.load();
    config.providers.gem!.apiKey = undefined;
    config.providers.gem!.apiKeyEnv = "BINY_IMAGE_TEST_KEY";
    config.imageGen.model = "gem:gemini-2.5-flash-image";
    await configStore.save(config);
    const cli = path.resolve("src/cli/index.ts");
    const invoke = async (args: string[]): Promise<{ stdout: string; stderr: string }> => await new Promise((resolve, reject) => {
      execFile(process.execPath, [...process.execArgv, cli, "image", ...args], { cwd: root, timeout: 20_000,
        env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent-state"), BINY_IMAGE_TEST_KEY: "stub-cli-key" }
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    const help = await invoke(["--help"]);
    assert.match(help.stdout, /generate|edit|models/u);
    const generated = await invoke(["generate", "CLI image", "--json"]);
    const result = JSON.parse(generated.stdout);
    outputPaths.add(result.path);
    assert.equal(result.model, "gem:gemini-2.5-flash-image");
    assert.deepEqual(await readFile(result.path), PIXEL_PNG);
    assert.match(generated.stderr, /configured/u);
    assert.doesNotMatch(generated.stderr, /stub-cli-key/u);
    assert.equal(server.requests[0]?.headers["x-goog-api-key"], "stub-cli-key");
  });
});

await test("未覆盖地址的 OpenRouter 连接使用自身默认图片端点", async t => {
  await fixture(async (root, _server, configStore) => {
    const config = await configStore.load();
    config.providers.router = { type: "openrouter", apiKey: "stub-router-key" };
    await configStore.save(config);
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL) => {
      urls.push(String(url));
      return Response.json({ data: [{ b64_json: PIXEL_PNG.toString("base64") }] });
    });
    await captureStdout(() => imageGenerateCommand(root, "a cat", { configStore, model: "router:openai/gpt-image-1" }));
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/images"]);
  });
});
