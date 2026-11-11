import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAttachment } from "../src/attachments/store.js";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import type { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostExecution } from "../src/runtime/host/composition.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { BinyTui } from "../src/tui/app.js";

const image: AgentAttachment = { name: "screen.png", mimeType: "image/png", data: "aW1hZ2U=", path: "@attachments/screen.png", size: 5 };
const audio: AgentAttachment = { name: "voice.wav", mimeType: "audio/wav", data: "UklGRg==", path: "@attachments/voice.wav", size: 4 };
const sessionId = "media-only";
interface CapturedInput { input: string; attachments: AgentAttachment[] }
interface FixtureRuntime {
  state: { kind: string; operation?: string };
  activeExecution: { run: { runId: string; sessionId: string }; controller: AbortController; completion: Promise<unknown> } | undefined;
  queuedMessages: CapturedInput[];
  getSnapshot(): unknown;
  submitPrompt: InteractiveAgentRuntime["submitPrompt"];
  waitForIdle: InteractiveAgentRuntime["waitForIdle"];
  startQueuedMessageRun(previous: { runId: string; sessionId: string }): void;
}
interface FixtureApp {
  submit: BinyTui["submit"];
  steerCurrentInput(): Promise<void>;
  setPendingAttachments(attachments: AgentAttachment[]): void;
  pendingAttachments: AgentAttachment[];
  editor: { setText(text: string): void };
}

/** Actual submission/router/runtime methods; only IO and provider execution are boundaries. */
function fixture(busy = false) {
  const submitted: CapturedInput[] = [];
  const steered: CapturedInput[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  const runtime = Object.assign(Object.create(InteractiveAgentRuntime.prototype) as object, {
    state: busy ? { kind: "runs" } : { kind: "idle" },
    activeExecution: busy ? { run: { runId: "previous", sessionId }, controller: new AbortController(), completion: Promise.resolve() } : undefined,
    queuedMessages: [], closed: false, revision: 0,
    commandRuntime: {
      agent: {
        getInfo: () => ({ sessionId }),
        queueSteering: async (_id: string, input: string, attachments: AgentAttachment[]) => { steered.push({ input, attachments }); },
        recordError: () => undefined
      },
      refreshSkills: async () => undefined
    },
    executeRun: async (run: CapturedInput & { runId: string }) => { submitted.push(run); return { runId: run.runId, status: "completed" }; },
    scheduleQueuedMessageRun: () => undefined,
    publishSnapshot: () => undefined,
    getSnapshot() { return { info: { sessionId }, state: this.state, revision: 0 }; }
  }) as unknown as FixtureRuntime;
  const server = Object.assign(Object.create(RuntimeHostServer.prototype) as object, {
    admission: { assertAdmission: () => undefined },
    assertRequestAdmission: () => undefined,
    ensureSessionWriter: async () => undefined,
    trackCompletion: () => undefined
  });
  const execution = Object.assign(Object.create(RuntimeHostExecution.prototype) as object, {
    host: server, oneShotSessions: new Map(),
    runtimeEntry: async () => ({ runtime, commands: {}, sessionId })
  }) as unknown as RuntimeHostExecution;
  // No connection/constructor side effects. Initialize the actual client state used by these APIs.
  const client = Object.assign(Object.create(RuntimeHostClient.prototype) as object, {
    options: { surface: "tui" }, focusedSessionId: sessionId,
    snapshot: runtime.getSnapshot(), snapshots: new Map([[sessionId, runtime.getSnapshot()]]), completions: new Map(),
    ensureSession: async () => ({ sessionId, snapshot: runtime.getSnapshot() }),
    request: async (operation: string, payload: unknown) => {
      requests.push(operation);
      const frame = JSON.parse(JSON.stringify({ kind: "request", requestId: "fixture", operation, payload }));
      return await execution.execute({ clientId: "fixture", surface: "tui" } as Parameters<RuntimeHostExecution["execute"]>[0], frame);
    }
  }) as unknown as RuntimeHostClient;
  let draft = "";
  const app = Object.assign(Object.create(BinyTui.prototype) as object, {
    runtime: client, workspaceRoot: "/synthetic-no-io", ownedSessionIds: new Set(), promptSubmissionQueue: Promise.resolve(),
    pendingAttachments: [], pendingAttachmentsView: { setAttachments: () => undefined }, ui: { requestRender: () => undefined },
    editor: { getExpandedText: () => draft, setText: (text: string) => { draft = text; }, undoStack: { clear: () => undefined } },
    ensureRuntimeStarted: async () => undefined,
    refreshContextUsage: async () => undefined,
    notify: () => undefined,
    dispatch: (event: { type: string; message?: string }) => { if (event.type === "error.message") errors.push(event.message ?? ""); }
  }) as unknown as FixtureApp;
  return { app, client, runtime, execution, submitted, steered, errors, requests };
}

for (const mode of ["idle", "queue", "steer"] as const) {
  for (const input of ["", "  \n "]) {
    test(`${mode}: TUI sends a native attachment without inventing user text`, async () => {
      const f = fixture(mode !== "idle");
      if (mode === "steer") {
        f.app.editor.setText(input); f.app.setPendingAttachments([image]); await f.app.steerCurrentInput();
      } else await f.app.submit(input, [image]);
      assert.deepEqual(f.errors, []);
      const received = mode === "idle" ? f.submitted : mode === "queue" ? f.runtime.queuedMessages : f.steered;
      assert.equal(received.length, 1);
      assert.equal(received[0]?.input, input);
      assert.deepEqual(received[0]?.attachments, [{ ...image, hiddenContext: undefined }]);
      assert.deepEqual(f.app.pendingAttachments, []);
      assert.equal(f.requests.length, 1);
    });
  }
}

for (const attachments of [
  [], [{ ...image, data: "" }], [{ ...image, data: " \n " }],
  [{ ...image, data: "", hiddenContext: "not native content" }],
  [{ ...image, mimeType: "application/octet-stream" }],
  [{ name: "document.txt", mimeType: "text/plain", data: "", path: "@attachments/document.txt" }]
] satisfies AgentAttachment[][]) {
  test("blank text still requires usable native media in client and direct runtime", async () => {
    const f = fixture();
    await assert.rejects(f.client.submitRunForSession(sessionId, "", attachments), /prompt cannot be empty/u);
    assert.throws(() => f.runtime.submitPrompt("", attachments), /prompt cannot be empty/u);
    assert.deepEqual(f.requests, []);
  });
}

for (const operation of ["run.submit", "run.queue", "queue"]) {
  for (const payload of [
    { input: "", attachments: [] }, { input: "  ", attachments: [{ ...image, data: "" }] },
    { attachments: [image] }, { input: 42, attachments: [image] },
    { input: "", attachments: [null] }, { input: "", attachments: [{ name: "bad", mimeType: "image/png" }] }
  ]) {
    test(`${operation}: invalid or empty message cannot be admitted`, async () => {
      const f = fixture(operation !== "run.submit");
      let result: unknown; let error: unknown;
      try {
        result = await f.execution.execute({ clientId: "fixture", surface: "tui" } as Parameters<RuntimeHostExecution["execute"]>[0],
          { kind: "request", requestId: "fixture", operation, payload });
      } catch (caught) { error = caught; }
      assert.ok(error instanceof Error || (result as { accepted?: boolean } | undefined)?.accepted === false);
      assert.equal(f.submitted.length + f.steered.length + f.runtime.queuedMessages.length, 0);
    });
  }
}

test("queued drain keeps the established media default prompt", async () => {
  const f = fixture(true); await f.app.submit("", [image]); assert.deepEqual(f.errors, []);
  const previous = f.runtime.activeExecution!.run; f.runtime.activeExecution = undefined; f.runtime.state = { kind: "idle" };
  f.runtime.startQueuedMessageRun(previous); await f.runtime.waitForIdle();
  assert.equal(f.submitted[0]?.input, "请分析这些附件。");
  assert.equal(f.submitted[0]?.attachments[0]?.data, image.data);
});

function contextMemory(): ContextMemory {
  const workspace: Pick<WorkspaceContext, "initialize" | "prepareTurn"> = {
    initialize: async () => undefined,
    prepareTurn: async () => ({
      instructions: [], explicitPaths: [], recentActivity: { paths: [], summaries: [] }, repoMapCandidates: [],
      snapshot: { refreshedAt: "2026-11-04T00:00:00.000Z", revision: 1,
        context: { cwd: "/synthetic", packageManager: "unknown", srcTree: [], gitStatus: "" } }
    })
  };
  return new ContextMemory(() => { throw new Error("Context assembly must not request a model."); },
    workspace as WorkspaceContext, undefined, 100_000, 32_768, undefined, undefined, { enabled: false, reserveTokens: 1024 });
}

for (const attachment of [image, audio]) {
  test(`${attachment.mimeType}: public context preparation does not fabricate placeholder text`, async () => {
    const prepared = await contextMemory().prepareTurn("", "system", undefined, [attachment], false);
    assert.deepEqual(prepared.messages.at(-1)?.content, [{
      type: attachment.mimeType.startsWith("image/") ? "image" : "audio", data: attachment.data, mimeType: attachment.mimeType
    }]);
    assert.ok(!JSON.stringify(prepared.messages).includes("(empty task)"));
  });
}

test("media-only turn context preserves the original media content", async () => {
  const prepared = await contextMemory().prepareTurn("", { systemPrompt: "system", turnContext: "reference context" }, undefined, [image], false);
  const user = prepared.messages.at(-1);
  assert.equal(user?.role, "user");
  if (user?.role !== "user") throw new Error("Missing user message.");
  assert.deepEqual(user.originalContent, [{ type: "image", data: image.data, mimeType: image.mimeType }]);
  assert.ok(!JSON.stringify(user).includes("(empty task)"));
});
