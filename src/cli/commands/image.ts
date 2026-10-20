/**
 * `biny image` — 本地生图/改图 CLI。
 *
 * 模型选择权威在 `imageGen.model` 配置；未配置时按内置优先级自动挑选。
 * 图片内容发给指定服务商；生成结果写入独立的本地临时文件。
 */
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import type { AgentConfig, ProviderConfig } from "../../config/schema.js";
import { providerDefinition, providerProtocol } from "../../ai/provider.js";
import { getSharedProxyAwareFetch } from "../../network/proxyFetch.js";
import { readBoundedBinaryFile } from "../../tools/file/safeFileIo.js";
import { redactSecrets } from "../../utils/secrets.js";

export interface ImageCommandStoreOptions {
  configStore?: AgentConfigStore;
}

function imageConfigStore(workspaceRoot: string, options?: ImageCommandStoreOptions): AgentConfigStore {
  return options?.configStore ?? createFileConfigStore(workspaceRoot);
}

const IMAGE_MODEL_PRIORITY = [
  "nano-banana-2",
  "nano-banana-pro",
  "nano-banana",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-2.0-flash"
];

export interface ImageCommandOptions {
  model?: string;
  aspect?: string;
  size?: string;
  reference?: string[];
  json?: boolean;
  /** Internal route used only by the owner-only local selfie command. */
  localOnly?: boolean;
}

interface ResolvedImageModel {
  providerAlias: string;
  provider: ProviderConfig;
  modelId: string;
  source: "configured" | "auto" | "manual";
}

function providerApiKey(provider: ProviderConfig): string | undefined {
  return provider.apiKey?.trim() || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv]?.trim() : undefined);
}

function isGeminiProvider(provider: ProviderConfig): boolean {
  if (provider.type === "gemini" || provider.type === "google") return true;
  try { return new URL(provider.baseUrl ?? "").hostname === "generativelanguage.googleapis.com"; }
  catch { return false; }
}

const maxImageBytes = 20 * 1024 * 1024;

function safeImageError(message: string, provider: ProviderConfig): string {
  const key = providerApiKey(provider);
  let safe = message;
  for (const secret of [key, ...Object.values(provider.headers ?? {})]) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return redactSecrets(safe);
}

async function readResponseBytes(response: Response, limit: number, prefixOnly = false): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (bytes < limit) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      const remaining = limit - bytes;
      if (chunk.value.length > remaining && !prefixOnly) throw new Error("Image response exceeds the size limit");
      const bounded = Buffer.from(chunk.value.subarray(0, remaining));
      chunks.push(bounded); bytes += bounded.length;
    }
    if (!done && !prefixOnly) {
      const extra = await reader.read();
      if (!extra.done) throw new Error("Image response exceeds the size limit");
      done = true;
    }
  } catch (error) {
    if (!prefixOnly) throw error;
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function imageRequest(provider: ProviderConfig, url: string, init: RequestInit = {}, timeoutMs = 300_000, localOnly = false): Promise<Response> {
  let response: Response;
  try {
    response = await getSharedProxyAwareFetch()(url, { ...init, redirect: localOnly ? "error" : init.redirect, signal: AbortSignal.timeout(provider.timeoutMs ?? timeoutMs) });
  } catch (error) { throw new Error(safeImageError(`Image request failed: ${String(error)}`, provider)); }
  if (!response.ok) {
    const diagnostic = (await readResponseBytes(response, 8_192, true)).toString("utf8");
    throw new Error(safeImageError(`Image API error: HTTP ${response.status} ${diagnostic}`.trim(), provider));
  }
  return response;
}

async function imageJson(response: Response): Promise<unknown> {
  const bytes = await readResponseBytes(response, 32 * 1024 * 1024);
  let data: unknown;
  try { data = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("Invalid image API JSON response"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid image API JSON response");
  return data;
}

function geminiBaseUrl(provider: ProviderConfig): string {
  const base = (provider.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "").replace(/\/openai$/u, "");
  return /\/v1(?:beta)?$/u.test(base) ? base : `${base}/v1beta`;
}

async function listGeminiImageModels(provider: ProviderConfig): Promise<string[]> {
  const models: string[] = [];
  const seenPages = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${geminiBaseUrl(provider)}/models`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await imageRequest(provider, url.href, {
      headers: { ...provider.headers, "x-goog-api-key": providerApiKey(provider)! }
    }, 30_000);
    const data = await imageJson(response) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string };
    if (!Array.isArray(data.models)) throw new Error("Invalid Gemini model catalog");
    models.push(...data.models.filter(model => typeof model?.name === "string"
      && Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent")
      && /image|nano-banana/u.test(model.name) && !model.name.includes("imagen"))
      .map(model => model.name.replace(/^models\//u, "")));
    pageToken = data.nextPageToken;
    if (pageToken !== undefined && (typeof pageToken !== "string" || seenPages.has(pageToken) || seenPages.size >= 100)) throw new Error("Invalid Gemini model catalog pagination");
    if (pageToken) seenPages.add(pageToken);
  } while (pageToken);
  return [...new Set(models)];
}

function pickBestGeminiModel(modelIds: string[]): string | undefined {
  for (const prefix of IMAGE_MODEL_PRIORITY) {
    const match = modelIds.find((id) => id.includes(prefix));
    if (match) return match;
  }
  return modelIds[0];
}

function splitProviderModel(spec: string): { providerAlias?: string; modelId: string } {
  const separator = spec.indexOf(":");
  const providerAlias = separator < 0 ? undefined : spec.slice(0, separator).trim();
  const modelId = (separator < 0 ? spec : spec.slice(separator + 1)).trim().replace(/^models\//u, "");
  if (!modelId || (separator >= 0 && !providerAlias) || /[?#\\\s]/u.test(modelId)) throw new Error("Invalid image model reference");
  return { providerAlias, modelId };
}

function enabledGeminiAlias(config: AgentConfig): string | undefined {
  return Object.keys(config.providers).find(alias => {
    const provider = config.providers[alias]!;
    return provider.enabled !== false && isGeminiProvider(provider) && Boolean(providerApiKey(provider));
  });
}

async function resolveImageModel(config: AgentConfig, override?: string): Promise<ResolvedImageModel> {
  const spec = override ?? config.imageGen.model?.trim();
  if ((spec !== undefined && spec !== "") || override !== undefined) {
    const { providerAlias, modelId } = splitProviderModel(spec ?? "");
    const alias = providerAlias ?? enabledGeminiAlias(config);
    if (!alias) throw new Error("No enabled Gemini provider configured with an API key");
    const provider = config.providers[alias];
    if (!provider) throw new Error(`Unknown provider alias: ${alias}`);
    if (provider.enabled === false) throw new Error(`Provider "${alias}" is disabled`);
    if (!providerApiKey(provider) && provider.requiresApiKey !== false) throw new Error(`Provider "${alias}" has no API key`);
    if (!isGeminiProvider(provider) && providerProtocol(provider, providerDefinition(provider.type)) !== "openai-compatible") {
      throw new Error(`Provider "${alias}" does not support the image API`);
    }
    return { providerAlias: alias, provider, modelId, source: override === undefined ? "configured" : "manual" };
  }
  const alias = enabledGeminiAlias(config);
  if (!alias) throw new Error("No enabled Gemini image provider configured; use --model alias:model-id for a compatible provider");
  const provider = config.providers[alias]!;
  const best = pickBestGeminiModel(await listGeminiImageModels(provider));
  if (!best) throw new Error("No Gemini image generation model available on the configured provider");
  return { providerAlias: alias, provider, modelId: best, source: "auto" };
}

async function resolveLocalSelfieModel(config: AgentConfig, override?: string): Promise<ResolvedImageModel> {
  const spec = override ?? config.imageGen.localModel?.trim();
  if (!spec) throw new Error("Configure imageGen.localModel before using `biny selfie take --nsfw`.");
  const resolved = await resolveImageModel(config, spec);
  if (isGeminiProvider(resolved.provider) || providerProtocol(resolved.provider, providerDefinition(resolved.provider.type)) !== "openai-compatible") {
    throw new Error("The local selfie model must use an OpenAI-compatible image provider.");
  }
  if (!isLoopbackImageEndpoint(resolved.provider.baseUrl)) {
    throw new Error("The local selfie model must use an HTTP(S) loopback baseUrl such as http://127.0.0.1:8188/v1.");
  }
  return { ...resolved, source: override === undefined ? "configured" : "manual" };
}

function isLoopbackImageEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    const loopback = address === "localhost"
      || isIP(address) === 4 && address.split(".")[0] === "127"
      || address === "::1";
    return loopback && (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

interface InputImage { data: Buffer; mimeType: string }

async function readInputImages(workspaceRoot: string, paths: string[]): Promise<InputImage[]> {
  const images: InputImage[] = [];
  let bytes = 0;
  for (const input of paths) {
    const filePath = await fs.realpath(path.resolve(workspaceRoot, input));
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[path.extname(filePath).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported input image format: ${input}`);
    const data = await readBoundedBinaryFile(filePath, maxImageBytes - bytes);
    if (!data.length) throw new Error(`Input image is empty: ${input}`);
    bytes += data.length; images.push({ data, mimeType });
  }
  return images;
}

function imageAspect(value: string | undefined): string | undefined {
  value = value?.trim();
  if (!value || value === "auto") return undefined;
  if (!/^([1-9]\d*):([1-9]\d*)$/u.test(value)) throw new Error("Image aspect ratio must be positive integers such as 16:9, or auto");
  return value;
}

function aspectToOpenAISize(aspect: string | undefined): string | undefined {
  if (!aspect || aspect === "auto") return undefined;
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(aspect);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w === h) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

async function writeImage(data: Buffer, mimeType: string): Promise<string> {
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" } as Record<string, string>)[mimeType.split(";")[0]!.trim().toLowerCase()];
  if (!extension || !data.length || data.length > maxImageBytes) throw new Error("Invalid or oversized generated image");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-image-gen-"));
  const filePath = path.join(directory, `image.${extension}`);
  try { await fs.writeFile(filePath, data, { mode: 0o600, flag: "wx" }); return filePath; }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

function decodeImage(value: string): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("Invalid or oversized base64 image");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Invalid base64 image");
  return decoded;
}

async function generateViaGemini(provider: ProviderConfig, modelId: string, options: { prompt: string; images: InputImage[]; aspect?: string }): Promise<string> {
  const response = await imageRequest(provider, `${geminiBaseUrl(provider)}/models/${encodeURIComponent(modelId)}:generateContent`, {
    method: "POST",
    headers: { ...provider.headers, "Content-Type": "application/json", "x-goog-api-key": providerApiKey(provider)! },
    body: JSON.stringify({
      contents: [{ parts: [...options.images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data.toString("base64") } })), { text: options.prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: options.aspect ? { aspectRatio: options.aspect } : undefined }
    })
  });
  const data = await imageJson(response) as { error?: { message?: string }; candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data: string } }> } }> };
  if (data.error) throw new Error(safeImageError(`Gemini API error: ${data.error.message ?? "unknown"}`, provider));
  for (const part of data.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) return await writeImage(decodeImage(part.inlineData.data), part.inlineData.mimeType ?? "image/png");
  }
  throw new Error("No image generated");
}

async function generateViaOpenAICompatible(provider: ProviderConfig, modelId: string, options: { prompt: string; images: InputImage[]; aspect?: string; localOnly?: boolean }): Promise<string> {
  const endpoint = provider.baseUrl ?? providerDefinition(provider.type).baseUrl;
  if (!endpoint) throw new Error("Image provider requires a baseUrl");
  const baseUrl = endpoint.replace(/\/+$/u, "");
  const apiKey = providerApiKey(provider);
  const headers = { ...provider.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  let response: Response;
  if (provider.type === "openrouter") {
    response = await imageRequest(provider, `${baseUrl}/images`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, prompt: options.prompt,
        input_references: options.images.length ? options.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data.toString("base64")}` } })) : undefined,
        aspect_ratio: options.aspect })
    }, 300_000, options.localOnly);
  } else if (options.images.length) {
    const form = new FormData();
    form.append("model", modelId); form.append("prompt", options.prompt);
    const size = aspectToOpenAISize(options.aspect); if (size) form.append("size", size);
    options.images.forEach((image, index) => form.append(options.images.length > 1 ? "image[]" : "image", new Blob([new Uint8Array(image.data)], { type: image.mimeType }), `input-${index}.${image.mimeType.split("/")[1]}`));
    const editHeaders = new Headers(headers); editHeaders.delete("Content-Type");
    response = await imageRequest(provider, `${baseUrl}/images/edits`, { method: "POST", headers: editHeaders, body: form }, 300_000, options.localOnly);
  } else {
    response = await imageRequest(provider, `${baseUrl}/images/generations`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, prompt: options.prompt, size: aspectToOpenAISize(options.aspect) }) }, 300_000, options.localOnly);
  }
  const data = await imageJson(response) as { output_format?: string; data?: Array<{ b64_json?: string; url?: string; media_type?: string }> };
  const image = data.data?.[0];
  if (!image) throw new Error("No image returned from API");
  if (image.b64_json) return await writeImage(decodeImage(image.b64_json), image.media_type ?? `image/${data.output_format ?? "png"}`);
  if (options.localOnly) throw new Error("The local selfie service must return image data directly, not a remote URL.");
  if (!image.url || !/^https?:\/\//u.test(image.url)) throw new Error("API returned no valid image URL or data");
  const downloaded = await imageRequest(provider, image.url, {}, 30_000);
  return await writeImage(await readResponseBytes(downloaded, maxImageBytes), downloaded.headers.get("content-type") ?? image.media_type ?? "image/png");
}

export async function imageModelsCommand(workspaceRoot: string, options: ImageCommandOptions & ImageCommandStoreOptions = {}): Promise<void> {
  const config = await imageConfigStore(workspaceRoot, options).load();
  const entries: Array<{ label: string; value: string; providerType: string }> = [];
  const errors: Array<{ providerAlias: string; message: string }> = [];
  for (const [alias, provider] of Object.entries(config.providers)) {
    if (provider.enabled === false || !providerApiKey(provider)) continue;
    if (isGeminiProvider(provider)) {
      try {
        const ids = await listGeminiImageModels(provider);
        for (const id of ids) entries.push({ label: `${alias}:${id}`, value: `${alias}:${id}`, providerType: "gemini" });
      } catch (error) { errors.push({ providerAlias: alias, message: safeImageError(String(error), provider) }); }
    } else if (provider.type === "openrouter") {
      try {
        const base = (provider.baseUrl ?? providerDefinition(provider.type).baseUrl!).replace(/\/+$/u, "");
        const response = await imageRequest(provider, `${base}/images/models`, { headers: { ...provider.headers, Authorization: `Bearer ${providerApiKey(provider)!}` } }, 30_000);
        const data = await imageJson(response) as { data?: Array<{ id: string }> };
        if (!Array.isArray(data.data)) throw new Error("Invalid image model catalog");
        for (const model of data.data) {
          if (typeof model?.id !== "string") throw new Error("Invalid image model catalog");
          entries.push({ label: `${alias}:${model.id}`, value: `${alias}:${model.id}`, providerType: "openrouter" });
        }
      } catch (error) { errors.push({ providerAlias: alias, message: safeImageError(String(error), provider) }); }
    }
  }
  const configured = (config.imageGen?.model ?? "").replace(/^models\//, "") || undefined;
  const autoAlias = enabledGeminiAlias(config);
  const autoModel = pickBestGeminiModel(entries.filter(entry => entry.value.startsWith(`${autoAlias}:`)).map(entry => entry.value.slice(entry.value.indexOf(":") + 1)));
  const autoBest = autoAlias && autoModel ? `${autoAlias}:${autoModel}` : undefined;
  const effectiveDefault = configured ? (() => {
    const { providerAlias, modelId } = splitProviderModel(configured);
    return `${providerAlias ?? autoAlias ?? "unconfigured"}:${modelId}`;
  })() : autoBest;
  if (effectiveDefault && !entries.some(entry => entry.value === effectiveDefault)) entries.push({ label: `${effectiveDefault} (configured)`, value: effectiveDefault, providerType: "configured" });
  if (options.json) {
    console.log(JSON.stringify({ models: entries, best: autoBest, default: effectiveDefault, errors }, null, 2));
    return;
  }
  for (const error of errors) console.error(`[image] ${error.providerAlias}: ${error.message}`);
  if (entries.length === 0) {
    console.error("No image generation model found (configure a Gemini provider with an API key)");
    return;
  }
  console.log("Available image generation models:");
  for (const entry of entries) {
    const mark = entry.value === effectiveDefault ? "*" : " ";
    console.log(`${mark} ${entry.label}`);
  }
  if (effectiveDefault) {
    const origin = configured ? "the configured default (imageGen.model)" : "auto-selected — no default configured";
    console.log(`\n* ${effectiveDefault} — used when you omit --model (${origin})`);
  }
}

export async function imageGenerateCommand(workspaceRoot: string, prompt: string, options: ImageCommandOptions & ImageCommandStoreOptions = {}): Promise<void> {
  const config = await imageConfigStore(workspaceRoot, options).load();
  if (!prompt.trim()) throw new Error("Image prompt must not be empty");
  const aspect = imageAspect(options.aspect ?? options.size ?? config.imageGen.aspectRatio);
  const images = await readInputImages(workspaceRoot, options.reference ?? []);
  const resolved = options.localOnly
    ? await resolveLocalSelfieModel(config, options.model)
    : await resolveImageModel(config, options.model);
  console.error(`[image] Using ${resolved.providerAlias}:${resolved.modelId} (${resolved.source})`);
  const outPath = isGeminiProvider(resolved.provider)
    ? await generateViaGemini(resolved.provider, resolved.modelId, { prompt, images, aspect })
    : await generateViaOpenAICompatible(resolved.provider, resolved.modelId, { prompt, images, aspect, localOnly: options.localOnly });
  if (options.json) console.log(JSON.stringify({ path: outPath, model: `${resolved.providerAlias}:${resolved.modelId}` }));
  else console.log(outPath);
}

export async function imageEditCommand(workspaceRoot: string, editPath: string, prompt: string, options: ImageCommandOptions & ImageCommandStoreOptions = {}): Promise<void> {
  const config = await imageConfigStore(workspaceRoot, options).load();
  if (!prompt.trim()) throw new Error("Image prompt must not be empty");
  const aspect = imageAspect(options.aspect ?? options.size ?? config.imageGen.aspectRatio);
  const images = await readInputImages(workspaceRoot, [editPath]);
  const resolved = await resolveImageModel(config, options.model);
  console.error(`[image] Using ${resolved.providerAlias}:${resolved.modelId} (${resolved.source})`);
  const outPath = isGeminiProvider(resolved.provider)
    ? await generateViaGemini(resolved.provider, resolved.modelId, { prompt, images, aspect })
    : await generateViaOpenAICompatible(resolved.provider, resolved.modelId, { prompt, images, aspect });
  if (options.json) console.log(JSON.stringify({ path: outPath, model: `${resolved.providerAlias}:${resolved.modelId}` }));
  else console.log(outPath);
}
