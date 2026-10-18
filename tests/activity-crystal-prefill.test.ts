/** Activity material references reach the same real AgentSession service used by CLI crystal prefill. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { messageText } from "../src/agent/modelMessages.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { createActivityMemoryPipeline, type ActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { DesktopCrystalService } from "../src/desktop/electron/main/DesktopCrystalService.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const project = "项目 Delta";
const activityTitle = "Delta activity title";
const activitySummary = `${project} preserves the staged release checklist.`;
const activityHighlight = "Activity highlight from the saved analysis";
const activityDecision = "Activity decision from the saved analysis";
const activityText = [activityTitle, activitySummary, activityHighlight, activityDecision].join("\n");
const conversationText = "Conversation evidence from the complete historical thread";
const conversationId = "crystal-history";
const conversationAnchor = "conversation-anchor";

interface Fixture {
  agent: AgentSession;
  desktop: DesktopCrystalService;
  crystalId: string;
  sessionId: string;
  activityTag: string;
  requests: ModelStreamContext[];
  setResponse(value: unknown): void;
}

await test("CLI crystal service reads activity-only material produced by the real activity pipeline", async () => {
  await withFixture({}, async (fixture) => {
    const desktop = await fixture.desktop.request({ action: "detail", id: fixture.crystalId });
    assert.deepEqual(Object.values(desktop.detail!.materialPreviews), [activityText],
      "The existing Desktop reader proves that the same saved reference has readable evidence.");
    const crystals = fixture.agent.getCrystalService();
    assert.equal(crystals.detail(fixture.crystalId)!.materials.length, 1);
    const filled = await crystals.prefill(fixture.crystalId);
    assert.equal(fixture.requests.length, 1);
    const prompt = requestText(fixture.requests[0]!);
    for (const text of [activityTitle, activitySummary, activityHighlight, activityDecision]) {
      assert.ok(prompt.includes(text), `Missing saved activity evidence: ${text}`);
    }
    assert.ok(prompt.includes(`[${fixture.activityTag}]`));
    assert.equal(filled.checklist.definition?.value, "Grounded fixture definition");
    assert.deepEqual(filled.checklist.definition?.sources, [fixture.activityTag]);
    assert.equal(filled.stage, "candidate", "Prefill must not confirm a crystal.");
  });
});

await test("CLI crystal prefill retains activity and ordinary conversation sources together", async () => {
  await withFixture({}, async (fixture) => {
    const crystals = fixture.agent.getCrystalService();
    crystals.addMaterial(fixture.crystalId, "turn", { threadId: conversationId, anchorId: conversationAnchor });
    const conversationTag = `turn:${conversationAnchor}`;
    fixture.setResponse({ definition: { value: "Definition grounded in both sources", sources: [fixture.activityTag, conversationTag] } });
    const filled = await crystals.prefill(fixture.crystalId);
    assert.equal(fixture.requests.length, 1);
    const prompt = requestText(fixture.requests[0]!);
    assert.ok(prompt.includes(activitySummary), "An unread activity source must not silently disappear from a mixed prefill.");
    assert.ok(prompt.includes(conversationText));
    assert.deepEqual(filled.checklist.definition?.sources, [fixture.activityTag, conversationTag]);
    assert.equal(filled.stage, "candidate");
  });
});

await test("global activity evidence remains readable from another workspace with a non-session project label", async () => {
  await withFixture({ otherWorkspace: true }, async (fixture) => {
    const crystals = fixture.agent.getCrystalService();
    const material = crystals.detail(fixture.crystalId)!.materials[0]!;
    assert.deepEqual(material.ref, { threadId: `activity:${project}`, anchorId: `activity:${fixture.sessionId}` });
    assert.equal(await crystals.readMaterialText(material), activityText);
    const filled = await crystals.prefill(fixture.crystalId);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(filled.checklist.definition?.sources, [fixture.activityTag]);
  });
});

await test("activity bundles use the same exact saved source through CLI crystal prefill", async () => {
  await withFixture({}, async (fixture) => {
    const crystals = fixture.agent.getCrystalService();
    const bundle = crystals.storage.insertBundle({ threadId: `activity:${project}`, anchorIds: [`activity:${fixture.sessionId}`] });
    const seed = crystals.createSeed("Activity bundle");
    crystals.setType(seed.id, "concept");
    crystals.addMaterial(seed.id, "bundle", { bundleId: bundle.id });
    const material = crystals.detail(seed.id)!.materials[0]!;
    const tag = `bundle:${material.id}`;
    fixture.setResponse({ definition: { value: "Bundle-grounded definition", sources: [tag] } });
    const filled = await crystals.prefill(seed.id);
    assert.equal(fixture.requests.length, 1);
    assert.ok(requestText(fixture.requests[0]!).includes(activitySummary));
    assert.deepEqual(filled.checklist.definition?.sources, [tag]);
  });
});

await test("disabled activity still blocks prefill before any model request", async () => {
  await withFixture({ enabled: false }, async (fixture) => {
    const crystals = fixture.agent.getCrystalService();
    await assert.rejects(crystals.prefill(fixture.crystalId), /当前活动权限不允许/u);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(crystals.detail(fixture.crystalId)!.crystal.checklist, {});
  });
});

const unreadableReferences: Array<{
  name: string;
  ref(sessionId: string): { threadId: string; anchorId: string };
}> = [
  { name: "unknown activity session", ref: () => ({ threadId: `activity:${project}`, anchorId: "activity:missing-session" }) },
  { name: "activity session ID prefix", ref: (id) => ({ threadId: `activity:${project}`, anchorId: `activity:${id.slice(0, -1)}` }) },
  { name: "activity thread with ordinary anchor namespace", ref: (id) => ({ threadId: `activity:${project}`, anchorId: id }) },
  { name: "ordinary thread with activity anchor namespace", ref: (id) => ({ threadId: conversationId, anchorId: `activity:${id}` }) },
  { name: "ordinary conversation thread prefix", ref: () => ({ threadId: "crystal-hist", anchorId: conversationAnchor }) },
  { name: "ordinary conversation path traversal", ref: () => ({ threadId: "../crystal-history", anchorId: conversationAnchor }) }
];

for (const example of unreadableReferences) {
  await test(`CLI crystal prefill rejects ${example.name} without a model request`, async () => {
    await withFixture({}, async (fixture) => {
      const crystals = fixture.agent.getCrystalService();
      const seed = crystals.createSeed("Unreadable source");
      crystals.setType(seed.id, "concept");
      crystals.addMaterial(seed.id, "turn", example.ref(fixture.sessionId));
      await assert.rejects(crystals.prefill(seed.id), /Materials have no readable text/u);
      assert.equal(fixture.requests.length, 0);
      assert.deepEqual(crystals.detail(seed.id)!.crystal.checklist, {});
    });
  });
}

await test("ordinary complete conversation IDs still resolve through the original CLI reader", async () => {
  await withFixture({}, async (fixture) => {
    const crystals = fixture.agent.getCrystalService();
    const seed = crystals.createSeed("Ordinary conversation");
    crystals.setType(seed.id, "concept");
    crystals.addMaterial(seed.id, "turn", { threadId: conversationId, anchorId: conversationAnchor });
    const tag = `turn:${conversationAnchor}`;
    fixture.setResponse({ definition: { value: "Conversation-grounded definition", sources: [tag] } });
    const filled = await crystals.prefill(seed.id);
    assert.equal(fixture.requests.length, 1);
    const prompt = requestText(fixture.requests[0]!);
    assert.ok(prompt.includes(conversationText));
    assert.ok(!prompt.includes(activitySummary));
    assert.deepEqual(filled.checklist.definition?.sources, [tag]);
  });
});

async function withFixture(
  options: { enabled?: boolean; otherWorkspace?: boolean },
  run: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-crystal-prefill-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const previousFetch = globalThis.fetch;
  const agentDir = path.join(root, "agent");
  const producerWorkspace = path.join(root, "producer");
  const workspaceRoot = options.otherWorkspace ? path.join(root, "consumer") : producerWorkspace;
  const activityDirectory = path.join(root, "activity-records");
  const store = new ActivityStore();
  const requests: ModelStreamContext[] = [];
  let unexpectedRequests = 0;
  let agent: AgentSession | undefined;
  let pipeline: ActivityMemoryPipeline | undefined;
  let response: unknown;
  process.env[BINY_AGENT_DIR_ENV] = agentDir;
  globalThis.fetch = async () => {
    unexpectedRequests += 1;
    throw new Error("Unexpected external request in activity crystal fixture.");
  };
  try {
    await mkdir(producerWorkspace, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await ensureAgentDirs(workspaceRoot);
    const historical = new SessionRecorder(workspaceRoot, conversationId);
    try {
      historical.record({ type: "user_message", messageId: conversationAnchor, content: conversationText });
    } finally {
      await historical.close();
    }

    const config = structuredClone(defaultConfig) as AgentConfig;
    config.providers = {};
    config.models = {};
    config.toolModel = undefined;
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.activity.enabled = options.enabled ?? true;
    config.activity.outputDirectory = activityDirectory;
    const model: AgentModel = {
      provider: "fixture",
      modelId: "activity-crystal-prefill-fixture",
      stream: async (context) => {
        requests.push(context);
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: JSON.stringify(response) };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    agent = new AgentSession({
      workspaceRoot, config, model, toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.initialize();
    const crystals = agent.getCrystalService();
    const seed = crystals.createSeed(project);
    crystals.setType(seed.id, "concept");

    await store.open(activityDirectory, agentDir);
    const startedAt = "2026-10-16T10:00:00.000Z";
    const endedAt = "2026-10-16T10:10:00.000Z";
    const sessionId = store.startSession(startedAt);
    store.recordEvent({ sessionId, occurredAt: startedAt, eventType: "app_focus", application: "Editor" });
    store.endSession(sessionId, endedAt);
    const analysis: ActivitySessionAnalysis = {
      sessionId, analyzedAt: endedAt, analyzerModel: "saved-fixture-analysis", analysisStatus: "analyzed",
      project, title: activityTitle, description: activitySummary, summary: activitySummary,
      topics: [project], prs: [], issues: [], people: [], versions: [],
      decisions: [activityDecision], entities: [project], highlights: [activityHighlight],
      worthMemory: false, worthKnowledge: true, isMeeting: false, storageTier: "standard",
      confidence: 1, sourceEventCount: 1, inputHash: `activity-crystal-prefill-${sessionId}`
    };
    store.recordAnalysis(analysis);
    pipeline = await createActivityMemoryPipeline({ workspaceRoot: producerWorkspace, agentDir });
    await pipeline.onAnalyzed(analysis, {
      id: sessionId, startedAt, endedAt, eventCount: 1, durationMs: 600_000, snapshotCount: 0
    });
    const activityTag = `turn:activity:${sessionId}`;
    response = { definition: { value: "Grounded fixture definition", sources: [activityTag] } };
    const desktop = new DesktopCrystalService(
      { load: async () => config, save: async () => undefined },
      async () => [workspaceRoot],
      () => new CrystalStorage({ agentDir })
    );
    await run({
      agent, desktop, crystalId: seed.id, sessionId, activityTag, requests,
      setResponse: (value) => { response = value; }
    });
  } finally {
    try {
      await agent?.close();
    } finally {
      try {
        pipeline?.close();
      } finally {
        try {
          await store.close();
        } finally {
          globalThis.fetch = previousFetch;
          if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
          else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
          await rm(root, { recursive: true, force: true });
          assert.equal(unexpectedRequests, 0, "The fixture must not dispatch external requests.");
        }
      }
    }
  }
}

function requestText(request: ModelStreamContext): string {
  return request.messages.map(messageText).join("\n");
}
