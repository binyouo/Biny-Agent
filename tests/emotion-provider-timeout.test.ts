import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeContextEmotion } from "../src/agent/context/emotionAnalysis.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { testModel } from "./helpers/model.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("emotion analysis accepts a response after ten seconds within the provider timeout", { timeout: 5_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-emotion-timeout-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = testModel({
    provider: "test", modelId: "slow-emotion", vercelOptions: { timeoutMs: 60_000 },
    async stream() {
      started.resolve();
      return (async function* () {
        await release.promise;
        yield { type: "text-delta" as const, text: '{"mood":"relieved","valence":8,"reason":"终于修好了"}' };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  });
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const storage = new EmotionStorage({ configDir: root });
    const result = analyzeContextEmotion({
      sessionId: "slow", storage, getModel: () => model,
      getMessages: async () => [{ role: "user", text: "终于修好了！" }]
    }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    await started.promise;
    t.mock.timers.tick(10_001);
    release.resolve();
    const outcome = await result;
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value?.mood, "relieved");
    assert.equal((await storage.readContext("slow"))?.trigger, "终于修好了");
  } finally {
    release.resolve();
    t.mock.timers.reset();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
