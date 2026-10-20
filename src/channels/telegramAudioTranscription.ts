import { spawn } from "node:child_process";

const telegramSampleRate = 16_000;
const telegramAudioMaxSeconds = 15 * 60;
const telegramAudioDecodeTimeoutMs = 60_000;

interface SpeechRecognitionPipeline {
  (audio: Float32Array, options: { task: "transcribe"; language?: string; chunk_length_s: number; stride_length_s: number }): Promise<{ text: string }>;
}

interface TransformersModule {
  pipeline(
    task: "automatic-speech-recognition",
    model: string,
    options: { cache_dir: string }
  ): Promise<SpeechRecognitionPipeline>;
}

export interface TelegramLocalAudioTranscriberOptions {
  model: string;
  cacheDirectory: string;
  language?: string;
  ffmpegPath?: string;
  decodeAudio?: (bytes: Buffer, signal: AbortSignal, ffmpegPath?: string) => Promise<Float32Array>;
  loadPipeline?: (model: string, cacheDirectory: string) => Promise<SpeechRecognitionPipeline>;
}

export function createTelegramLocalAudioTranscriber(options: TelegramLocalAudioTranscriberOptions):
  (bytes: Buffer, signal: AbortSignal) => Promise<{ text: string; language?: string } | undefined> {
  let pipelinePromise: Promise<SpeechRecognitionPipeline> | undefined;
  const loadPipeline = options.loadPipeline ?? loadTransformersPipeline;
  const decodeAudio = options.decodeAudio ?? decodeTelegramAudio;

  const getPipeline = (): Promise<SpeechRecognitionPipeline> => {
    if (!pipelinePromise) {
      pipelinePromise = loadPipeline(options.model, options.cacheDirectory).catch((error: unknown) => {
        pipelinePromise = undefined;
        throw error;
      });
    }
    return pipelinePromise;
  };

  return async (bytes, signal) => {
    if (signal.aborted) throw signal.reason ?? new Error("Telegram audio transcription cancelled.");
    const audio = await decodeAudio(bytes, signal, options.ffmpegPath);
    if (signal.aborted) throw signal.reason ?? new Error("Telegram audio transcription cancelled.");
    if (audio.length === 0) return undefined;
    const transcriber = await getPipeline();
    if (signal.aborted) throw signal.reason ?? new Error("Telegram audio transcription cancelled.");
    const result = await transcriber(audio, {
      task: "transcribe",
      language: options.language,
      chunk_length_s: 30,
      stride_length_s: 5
    });
    if (signal.aborted) throw signal.reason ?? new Error("Telegram audio transcription cancelled.");
    const text = result.text.trim();
    return text ? { text, language: options.language } : undefined;
  };
}

async function loadTransformersPipeline(model: string, cacheDirectory: string): Promise<SpeechRecognitionPipeline> {
  const transformers = await import("@huggingface/transformers") as unknown as TransformersModule;
  return await transformers.pipeline("automatic-speech-recognition", model, { cache_dir: cacheDirectory });
}

function decodeTelegramAudio(bytes: Buffer, signal: AbortSignal, ffmpegPath = "ffmpeg"): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Telegram audio transcription cancelled."));
      return;
    }

    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:a:0", "-vn",
      "-ac", "1", "-ar", String(telegramSampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    const maximumBytes = telegramSampleRate * telegramAudioMaxSeconds * Float32Array.BYTES_PER_ELEMENT;
    let outputBytes = 0;
    let tooLong = false;
    let timedOut = false;
    let settled = false;
    let processError: Error | undefined;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => { child.kill(); };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, telegramAudioDecodeTimeoutMs);
    timeout.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      processError = new Error("Local audio decoding is unavailable.");
      child.kill();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumBytes) {
        tooLong = true;
        child.kill();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Telegram audio transcription cancelled."));
      } else if (processError) {
        reject(processError);
      } else if (tooLong) {
        reject(new Error("Telegram audio is too long for local transcription."));
      } else if (timedOut) {
        reject(new Error("Local audio decoding timed out."));
      } else if (code !== 0 || outputBytes === 0 || outputBytes % Float32Array.BYTES_PER_ELEMENT !== 0) {
        reject(new Error("Telegram audio could not be decoded for local transcription."));
      } else {
        const output = Buffer.concat(chunks, outputBytes);
        resolve(new Float32Array(output.buffer, output.byteOffset, output.byteLength / Float32Array.BYTES_PER_ELEMENT));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  });
}
