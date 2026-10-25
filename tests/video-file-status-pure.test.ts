import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { Script, createContext } from "node:vm";

// Execute only complete selected source functions, never the CLI or its imports.
// All requests, response readers, waits and timeout creation below are inert.
const source = readFileSync(new URL("../src/cli/commands/video.ts", import.meta.url), "utf8");
function declaration(name: string): string {
  const pattern = new RegExp(`^(?:async )?function ${name}\\(`, "mu");
  const matches = [...source.matchAll(new RegExp(pattern.source, "gmu"))];
  assert.equal(matches.length, 1, `unique complete function ${name}`);
  const start = matches[0]!.index!;
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}
const selected = ["readResponseText", "responseJson", "apiHeaders", "apiRequest", "fileEndpoint", "waitForGeminiFile"].map(declaration).join("\n");
const constants = ["processingPollIntervalMs", "processingPollAttempts"].map(name => {
  const match = source.match(new RegExp(`^const ${name} = [\\d_]+;$`, "mu"));
  assert.ok(match);
  return match[0];
}).join("\n");
const script = new Script(stripTypeScriptTypes(`${constants}\n${selected}\n({ waitForGeminiFile });`, { mode: "strip" }), { filename: "inert-video-file-status.js" });

interface FileRecord { name: string; uri: string; mimeType: string; state?: string; }
interface Step { payload?: unknown; raw?: string; status?: number; fetchError?: string; }
interface Scenario { name: string; initial?: string; omitInitial?: true; steps: Step[]; error?: string; expectedState?: string; waitError?: true; }
const identity = { name: "files/one", uri: "fixture:video-uri", mimeType: "video/mp4" };
const active = { ...identity, state: "ACTIVE" };
const processing = { ...identity, state: "PROCESSING" };
const scenarios: Scenario[] = [
  { name: "direct ACTIVE File completes a processing upload", steps: [{ payload: active }], expectedState: "ACTIVE" },
  { name: "direct PROCESSING File continues until ACTIVE", steps: [{ payload: processing }, { payload: active }], expectedState: "ACTIVE" },
  { name: "omitted initial state follows direct File status", omitInitial: true, steps: [{ payload: active }], expectedState: "ACTIVE" },
  { name: "direct FAILED state reports processing failure", steps: [{ payload: { ...identity, state: "FAILED" } }], error: "Gemini could not process this video." },
  { name: "poll response cannot overwrite original URI or MIME", steps: [{ payload: { name: identity.name, state: "ACTIVE", uri: "fixture:replacement", mimeType: "video/webm" } }], expectedState: "ACTIVE" },
  { name: "mismatched file name remains invalid", steps: [{ payload: { ...active, name: "files/other" } }], error: "Gemini returned invalid file status." },
  { name: "unknown status remains invalid", steps: [{ payload: { ...identity, state: "ERROR" } }], error: "Gemini returned invalid file status." },
  { name: "missing status remains invalid", steps: [{ payload: identity }], error: "Gemini returned invalid file status." },
  { name: "missing name remains invalid", steps: [{ payload: { state: "ACTIVE" } }], error: "Gemini returned invalid file status." },
  { name: "null response remains invalid JSON record", steps: [{ payload: null }], error: "Gemini returned invalid JSON." },
  { name: "array response remains invalid JSON record", steps: [{ payload: [active] }], error: "Gemini returned invalid JSON." },
  { name: "string response remains invalid JSON record", steps: [{ payload: "ACTIVE" }], error: "Gemini returned invalid JSON." },
  { name: "malformed JSON remains distinct", steps: [{ raw: "{" }], error: "Gemini returned invalid JSON." },
  { name: "HTTP failure remains distinct", steps: [{ status: 503 }], error: "Gemini video request failed (HTTP 503)." },
  { name: "fetch rejection remains distinct", steps: [{ fetchError: "synthetic transport failure" }], error: "Gemini video request failed: Error: synthetic transport failure" },
  { name: "already ACTIVE does not poll", initial: "ACTIVE", steps: [], expectedState: "ACTIVE" },
  { name: "already FAILED does not poll", initial: "FAILED", steps: [], error: "Gemini could not process this video." },
  { name: "initial unknown status does not poll", initial: "ERROR", steps: [], error: "Gemini could not process this video." },
  { name: "wait rejection does not request", steps: [], waitError: true, error: "synthetic wait failure" },
  { name: "150 direct PROCESSING responses preserve polling bound", steps: Array.from({ length: 150 }, () => ({ payload: processing })), error: "Gemini video processing timed out." }
];
assert.equal(scenarios.length, 20);

for (const scenario of scenarios) {
  test(`Gemini video File status: ${scenario.name}`, async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const timeouts: number[] = [];
    const violations: string[] = [];
    const steps = [...scenario.steps];
    let readerCancels = 0;
    let readerReleases = 0;
    let bodyCancels = 0;
    let expectedReaders = 0;
    const fail = (name: string): never => { violations.push(name); throw new Error(`Unexpected fixture capability: ${name}`); };
    const signal = Object.freeze({ fixture: "timeout-token" });
    const fetcher = async (url: string, init: { redirect: string; signal: unknown; headers: Record<string, string>; method?: string; body?: unknown }) => {
      calls.push(url);
      assert.equal(url, "https://video-fixture.invalid/v1beta/files/one");
      assert.equal(init.redirect, "error");
      assert.equal(init.signal, signal);
      assert.equal(init.method, undefined);
      assert.equal(init.body, undefined);
      assert.deepEqual({ ...init.headers }, { "x-goog-api-key": "synthetic-key" });
      const step = steps.shift();
      if (!step) return fail("unexpected request");
      if (step.fetchError) throw new Error(step.fetchError);
      const ok = (step.status ?? 200) >= 200 && (step.status ?? 200) < 300;
      const bytes = Buffer.from(step.raw ?? (step.payload === undefined ? "{}" : JSON.stringify(step.payload)));
      let read = false;
      if (ok) expectedReaders += 1;
      return {
        ok, status: step.status ?? 200,
        body: {
          cancel: async () => { bodyCancels += 1; },
          getReader: () => ({
            read: async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: bytes };
            },
            cancel: async () => { readerCancels += 1; },
            releaseLock: () => { readerReleases += 1; }
          })
        }
      };
    };
    const context = createContext({
      Buffer, Headers,
      AbortSignal: Object.freeze({ timeout: (ms: number) => { timeouts.push(ms); return signal; } }),
      redactSecrets: (value: string) => value,
      fetch: () => fail("global fetch"),
      setTimeout: () => fail("real timer"),
      process: new Proxy({}, { get: () => fail("process") })
    }, { codeGeneration: { strings: false, wasm: false } });
    const product = script.runInContext(context, { timeout: 1000 }) as {
      waitForGeminiFile(model: unknown, file: FileRecord, fetcher: unknown, wait: (milliseconds: number) => Promise<void>): Promise<FileRecord>;
    };
    const initial = { ...identity, ...(scenario.omitInitial ? {} : { state: scenario.initial ?? "PROCESSING" }) };
    const original = { ...initial };
    const operation = product.waitForGeminiFile({ baseUrl: "https://video-fixture.invalid/v1beta", provider: {}, apiKey: "synthetic-key" }, initial, fetcher, async ms => {
      waits.push(ms);
      if (scenario.waitError) throw new Error("synthetic wait failure");
    });
    try {
      if (scenario.error) await assert.rejects(operation, (error: unknown) => typeof error === "object" && error !== null && "message" in error && error.message === scenario.error);
      else assert.deepEqual({ ...await operation }, { ...identity, state: scenario.expectedState });
      assert.deepEqual(initial, original, "polling must not mutate the initial upload record");
      assert.equal(steps.length, 0);
      assert.equal(calls.length, scenario.steps.length);
      assert.deepEqual(waits, Array.from({ length: scenario.waitError ? 1 : scenario.steps.length }, () => 2000));
      assert.deepEqual(timeouts, Array.from({ length: scenario.steps.length }, () => 600000));
      assert.equal(readerCancels, expectedReaders);
      assert.equal(readerReleases, expectedReaders);
      assert.equal(bodyCancels, scenario.steps.filter(step => (step.status ?? 200) >= 300).length);
    } finally {
      assert.deepEqual(violations, [], "caught boundary violations still fail");
    }
  });
}

test("upload response keeps its separate documented file envelope (source control)", () => {
  const upload = declaration("uploadVideo");
  assert.match(upload, /const data = await responseJson\(uploaded\);\s+const file = data\.file;/u);
  assert.match(upload, /const record = file as Record<string, unknown>;/u);
});
