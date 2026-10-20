import assert from "node:assert/strict";
import { createTelegramLocalAudioTranscriber } from "../src/channels/telegramAudioTranscription.js";

await testLocalTranscriberLoadsOnceAndReturnsConfiguredLanguage();
await testLocalTranscriberHonorsCancellationBeforeDecoding();
console.log("telegram audio transcription tests passed");

async function testLocalTranscriberLoadsOnceAndReturnsConfiguredLanguage(): Promise<void> {
  let loads = 0;
  let decodes = 0;
  const samples = new Float32Array([0.25, -0.25]);
  const transcribe = createTelegramLocalAudioTranscriber({
    model: "onnx-community/whisper-tiny",
    cacheDirectory: "/tmp/biny-telegram-whisper-cache",
    language: "chinese",
    decodeAudio: async (bytes, signal, ffmpegPath) => {
      decodes += 1;
      assert.equal(bytes.toString(), "audio bytes");
      assert.equal(signal.aborted, false);
      assert.equal(ffmpegPath, undefined);
      return samples;
    },
    loadPipeline: async (model, cacheDirectory) => {
      loads += 1;
      assert.equal(model, "onnx-community/whisper-tiny");
      assert.equal(cacheDirectory, "/tmp/biny-telegram-whisper-cache");
      return async (audio, options) => {
        assert.equal(audio, samples);
        assert.deepEqual(options, { task: "transcribe", language: "chinese", chunk_length_s: 30, stride_length_s: 5 });
        return { text: "  帮我记录一下  " };
      };
    }
  });

  const first = await transcribe(Buffer.from("audio bytes"), new AbortController().signal);
  const second = await transcribe(Buffer.from("audio bytes"), new AbortController().signal);
  assert.deepEqual(first, { text: "帮我记录一下", language: "chinese" });
  assert.deepEqual(second, first);
  assert.equal(loads, 1, "the local model pipeline is reused for the bridge lifetime");
  assert.equal(decodes, 2, "each Telegram audio file is decoded independently");
}

async function testLocalTranscriberHonorsCancellationBeforeDecoding(): Promise<void> {
  let decoded = false;
  let loaded = false;
  const controller = new AbortController();
  controller.abort(new Error("bridge stopped"));
  const transcribe = createTelegramLocalAudioTranscriber({
    model: "onnx-community/whisper-tiny",
    cacheDirectory: "/tmp/biny-telegram-whisper-cache",
    decodeAudio: async () => {
      decoded = true;
      return new Float32Array();
    },
    loadPipeline: async () => {
      loaded = true;
      return async () => ({ text: "unexpected" });
    }
  });

  await assert.rejects(transcribe(Buffer.from("audio bytes"), controller.signal), /bridge stopped/u);
  assert.equal(decoded, false);
  assert.equal(loaded, false);
}
