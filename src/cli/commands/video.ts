import { constants, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import type { AgentConfig, ProviderConfig } from "../../config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import { providerDefinition } from "../../ai/provider.js";
import { readAttachmentBytes } from "../../attachments/store.js";
import { attachmentRelativePath } from "../../attachments/paths.js";
import { getSharedProxyAwareFetch } from "../../network/proxyFetch.js";
import { redactSecrets } from "../../utils/secrets.js";

const maxVideoBytes = 2 * 1024 * 1024 * 1024;
const maxAttachmentVideoBytes = 40 * 1024 * 1024;
const processingPollIntervalMs = 2_000;
const processingPollAttempts = 150;

export interface VideoCommandOptions {
  model?: string;
  json?: boolean;
}

export interface VideoCommandDependencies {
  configStore?: Pick<AgentConfigStore, "load">;
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

interface GeminiVideoModel {
  alias: string;
  provider: ProviderConfig;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

interface OpenVideoInput {
  filePath?: string;
  name: string;
  mimeType: string;
  size: number;
  bytes?: Buffer;
  handle?: Awaited<ReturnType<typeof fs.open>>;
  close(): Promise<void>;
}

const videoMimeTypes: Readonly<Record<string, string>> = {
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".webm": "video/webm"
};

function isGeminiProvider(provider: ProviderConfig): boolean {
  if (provider.type === "gemini" || provider.type === "google") return true;
  try { return new URL(provider.baseUrl ?? "").hostname === "generativelanguage.googleapis.com"; }
  catch { return false; }
}

function providerApiKey(provider: ProviderConfig): string | undefined {
  return provider.apiKey?.trim()
    || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv]?.trim() : undefined);
}

function normalizeGeminiBaseUrl(provider: ProviderConfig): string {
  const definition = provider.type === "gemini" ? providerDefinition("gemini") : undefined;
  const base = (provider.baseUrl ?? definition?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta")
    .replace(/\/+$/u, "").replace(/\/openai$/u, "");
  const parsed = new URL(base);
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Gemini provider baseUrl must not contain credentials or query parameters.");
  }
  return /\/v1(?:beta)?$/u.test(base) ? base : `${base}/v1beta`;
}

function splitModelReference(reference: string): { alias?: string; modelId: string } {
  const colon = reference.indexOf(":");
  const alias = colon < 0 ? undefined : reference.slice(0, colon).trim();
  const modelId = (colon < 0 ? reference : reference.slice(colon + 1)).trim().replace(/^models\//u, "");
  if (!modelId || (colon >= 0 && !alias) || /[?#\\\s]/u.test(modelId)) throw new Error("Invalid video model reference.");
  return { alias, modelId };
}

function resolveGeminiModel(config: AgentConfig, override?: string): GeminiVideoModel {
  const parsed = override === undefined ? undefined : splitModelReference(override);
  const defaultModel = config.models[config.defaultModel];
  const defaultProvider = defaultModel ? config.providers[defaultModel.provider] : undefined;
  const preferredAlias = defaultProvider && isGeminiProvider(defaultProvider) ? defaultModel?.provider : undefined;
  const candidates = parsed?.alias
    ? [parsed.alias]
    : [...new Set([preferredAlias, ...Object.keys(config.providers)])].filter((alias): alias is string => Boolean(alias));
  const alias = candidates.find(candidate => {
    const provider = config.providers[candidate];
    return provider !== undefined && provider.enabled !== false && isGeminiProvider(provider) && Boolean(providerApiKey(provider));
  });
  if (!alias) throw new Error("Configure an enabled Gemini provider with an API key, or pass --model provider:model.");
  const provider = config.providers[alias]!;
  const configuredModel = defaultModel?.provider === alias ? defaultModel.model : undefined;
  const modelId = parsed?.modelId ?? configuredModel ?? "gemini-2.5-flash";
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`Gemini provider "${alias}" has no API key.`);
  return { alias, provider, modelId, apiKey, baseUrl: normalizeGeminiBaseUrl(provider) };
}

async function openVideoInput(workspaceRoot: string, input: string): Promise<OpenVideoInput> {
  let filePath: string;
  let attachmentBytes: Buffer | undefined;
  if (input.startsWith("@attachments/")) {
    const relative = attachmentRelativePath(input);
    if (!relative) throw new Error("Invalid attachment path.");
    attachmentBytes = await readAttachmentBytes(workspaceRoot, input, maxAttachmentVideoBytes);
    if (!attachmentBytes) throw new Error("Video attachment is unavailable.");
    filePath = path.join("attachments", relative);
  } else {
    filePath = path.resolve(workspaceRoot, input);
  }

  const extension = path.extname(filePath).toLowerCase();
  const mimeType = videoMimeTypes[extension];
  if (!mimeType) throw new Error(`Unsupported video format: ${extension || "unknown"}.`);
  if (attachmentBytes) {
    if (!attachmentBytes.length) throw new Error("Video file is empty.");
    return { name: path.basename(filePath), mimeType, size: attachmentBytes.length, bytes: attachmentBytes, close: async () => undefined };
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const [stat, pathStat] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (!stat.isFile() || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error("Video path must refer to a regular file.");
    }
    if (stat.size <= 0) throw new Error("Video file is empty.");
    if (stat.size > maxVideoBytes) throw new Error("Video file exceeds the 2 GB Gemini Files API limit.");
    let closed = false;
    return {
      filePath,
      name: path.basename(filePath),
      mimeType,
      size: stat.size,
      bytes: undefined,
      handle,
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      }
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readResponseText(response: Response, limit = 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (bytes <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit + 1 - bytes;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > limit) throw new Error("Gemini response exceeds the size limit.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await readResponseText(response);
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error("Gemini returned invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini returned invalid JSON.");
  return value as Record<string, unknown>;
}

function apiHeaders(model: GeminiVideoModel): Record<string, string> {
  const headers = new Headers(model.provider.headers);
  headers.set("x-goog-api-key", model.apiKey);
  return Object.fromEntries(headers.entries());
}

async function apiRequest(
  model: GeminiVideoModel,
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { ...apiHeaders(model), ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(model.provider.timeoutMs ?? 600_000)
    });
  } catch (error) {
    throw new Error(redactSecrets(`Gemini video request failed: ${String(error)}`).replaceAll(model.apiKey, "[redacted]"));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Gemini video request failed (HTTP ${response.status}).`);
  }
  return response;
}

function uploadEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/v1(?:beta)?$/u, match => `/upload${match}`) + "/files";
}

function uploadUrlFrom(response: Response, baseUrl: string): string {
  const raw = response.headers.get("x-goog-upload-url");
  if (!raw) throw new Error("Gemini did not return a resumable upload URL.");
  let uploadUrl: URL;
  try { uploadUrl = new URL(raw, baseUrl); }
  catch { throw new Error("Gemini returned an invalid resumable upload URL."); }
  if (uploadUrl.origin !== new URL(baseUrl).origin || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
    throw new Error("Gemini returned an unsafe resumable upload URL.");
  }
  return uploadUrl.href;
}

async function uploadVideo(
  model: GeminiVideoModel,
  video: OpenVideoInput,
  fetcher: typeof fetch
): Promise<{ name: string; uri: string; mimeType: string; state?: string }> {
  const start = await apiRequest(model, fetcher, uploadEndpoint(model.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(video.size),
      "X-Goog-Upload-Header-Content-Type": video.mimeType
    },
    body: JSON.stringify({ file: { display_name: video.name } })
  });
  await start.body?.cancel().catch(() => undefined);
  const uploadUrl = uploadUrlFrom(start, model.baseUrl);
  const stream = video.bytes
    ? Readable.from([video.bytes])
    : video.handle!.createReadStream({ autoClose: false, start: 0, end: video.size - 1 });
  let uploaded: Response;
  try {
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    uploaded = await apiRequest(model, fetcher, uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": video.mimeType,
        "Content-Length": String(video.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
  } finally {
    stream.destroy();
    await video.close();
  }
  const data = await responseJson(uploaded);
  const file = data.file;
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Gemini returned invalid uploaded file metadata.");
  const record = file as Record<string, unknown>;
  if (typeof record.name !== "string" || !/^files\/[A-Za-z0-9_-]+$/u.test(record.name)
    || typeof record.uri !== "string" || !record.uri || record.uri.length > 4096
    || typeof record.mimeType !== "string" || !record.mimeType.startsWith("video/")) {
    throw new Error("Gemini returned invalid uploaded file metadata.");
  }
  return { name: record.name, uri: record.uri, mimeType: record.mimeType, state: typeof record.state === "string" ? record.state : undefined };
}

function fileEndpoint(baseUrl: string, name: string): string {
  const id = name.slice("files/".length);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error("Gemini returned an invalid file name.");
  return `${baseUrl}/files/${encodeURIComponent(id)}`;
}

async function waitForGeminiFile(
  model: GeminiVideoModel,
  file: { name: string; uri: string; mimeType: string; state?: string },
  fetcher: typeof fetch,
  wait: (milliseconds: number) => Promise<void>
): Promise<typeof file> {
  let current = file;
  for (let attempt = 0; current.state === "PROCESSING" || current.state === undefined; attempt += 1) {
    if (attempt >= processingPollAttempts) throw new Error("Gemini video processing timed out.");
    await wait(processingPollIntervalMs);
    const response = await apiRequest(model, fetcher, fileEndpoint(model.baseUrl, current.name));
    const data = await responseJson(response);
    const raw = data.file;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Gemini returned invalid file status.");
    const record = raw as Record<string, unknown>;
    if (record.name !== current.name || (record.state !== "PROCESSING" && record.state !== "ACTIVE" && record.state !== "FAILED")) {
      throw new Error("Gemini returned invalid file status.");
    }
    current = { ...current, state: record.state };
  }
  if (current.state !== "ACTIVE") throw new Error("Gemini could not process this video.");
  return current;
}

async function analyzeUploadedVideo(
  model: GeminiVideoModel,
  file: { name: string; uri: string; mimeType: string },
  prompt: string,
  fetcher: typeof fetch
): Promise<string> {
  const response = await apiRequest(model, fetcher,
    `${model.baseUrl}/models/${encodeURIComponent(model.modelId)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [
        { file_data: { file_uri: file.uri, mime_type: file.mimeType } },
        { text: prompt }
      ] }] })
    });
  const data = await responseJson(response);
  const candidates = data.candidates;
  if (!Array.isArray(candidates)) throw new Error("Gemini returned no video analysis result.");
  const candidate = candidates.find(item => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
  const content = candidate?.content;
  const parts = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>).parts : undefined;
  const answer = Array.isArray(parts)
    ? parts.flatMap(part => part && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string"
      ? [(part as Record<string, unknown>).text as string] : []).join("").trim()
    : "";
  if (!answer) throw new Error("Gemini returned an empty video analysis result.");
  return answer;
}

async function deleteUploadedVideo(model: GeminiVideoModel, fileName: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(fileEndpoint(model.baseUrl, fileName), {
    method: "DELETE",
    headers: apiHeaders(model),
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await response.body?.cancel().catch(() => undefined);
}

export async function videoAnalyzeCommand(
  workspaceRoot: string,
  inputPath: string,
  prompt: string,
  options: VideoCommandOptions = {},
  dependencies: VideoCommandDependencies = {}
): Promise<void> {
  if (!prompt.trim()) throw new Error("Video analysis prompt must not be empty.");
  const store = dependencies.configStore ?? createFileConfigStore(workspaceRoot);
  const config = await store.load();
  const model = resolveGeminiModel(config, options.model);
  const video = await openVideoInput(workspaceRoot, inputPath);
  const fetcher = dependencies.fetcher ?? getSharedProxyAwareFetch();
  let remoteFile: { name: string; uri: string; mimeType: string; state?: string } | undefined;
  let result: string;
  try {
    remoteFile = await uploadVideo(model, video, fetcher);
    const activeFile = await waitForGeminiFile(model, remoteFile, fetcher, dependencies.wait ?? (async ms => await new Promise(resolve => setTimeout(resolve, ms))));
    result = await analyzeUploadedVideo(model, activeFile, prompt.trim(), fetcher);
  } finally {
    await video.close().catch(() => undefined);
    if (remoteFile) {
      try { await deleteUploadedVideo(model, remoteFile.name, fetcher); }
      catch { console.error("[video] Remote upload cleanup failed; the file will expire automatically."); }
    }
  }
  if (options.json) console.log(JSON.stringify({ text: result, model: `${model.alias}:${model.modelId}` }));
  else console.log(result);
}
