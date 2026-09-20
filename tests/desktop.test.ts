import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRunOptions, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { createInteractiveAgentHost, InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { isTerminalRunEvent, pendingPermission, type AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { RuntimeHostFactoryOptions } from "../src/runtime/host/types.js";
import type { CredentialStore } from "../src/config/credentials.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { openAiCodexCatalogModels } from "../src/ai/codexModels.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopSafeStorageCredentialStore, type SafeStorageCipher } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";
import { DesktopModelLoginService } from "../src/desktop/electron/main/DesktopModelLoginService.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { clampFilePanelWidth, DEFAULT_FILE_PANEL_WIDTH, MAX_FILE_PANEL_WIDTH, MIN_FILE_PANEL_WIDTH } from "../src/desktop/filePanelSizing.js";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_RAIL_WIDTH } from "../src/desktop/sidebarSizing.js";
import { resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopSettingsSaveInput,
  DesktopSettingsSnapshot,
  DesktopSkillCatalogEntry,
  DesktopWorkspaceSnapshot
} from "../src/desktop/protocol.js";
import {
  applyProjectOrder,
  applyUpdatesToSidebarSessions,
  applyUpdatesToWorkspace,
  lastReportedInputTokens,
  replaceProjectSessionRoots,
  replaceProjectSessions,
  updateRuntimeInfo
} from "../src/desktop/renderer/src/app/desktopState.js";
import {
  canNavigateBack,
  canNavigateForward,
  createNavigationState,
  moveNavigation,
  pushNavigation,
  replaceNavigation
} from "../src/desktop/renderer/src/navigationHistory.js";
import { buildSessionTimeline, listChangedFiles, liveTimelineEvents } from "../src/desktop/renderer/src/sessionTimeline.js";
import { formatContextUsage, formatUsageCost } from "../src/desktop/renderer/src/usagePresentation.js";
import { reasoningDetailText } from "../src/desktop/renderer/src/reasoningPresentation.js";
import { projectWebSearchView } from "../src/desktop/renderer/src/webSearchPresentation.js";
import { catalogForConnection, customCatalogEntry, providerCatalog } from "../src/desktop/renderer/src/providerCatalog.js";
import { connectionLabel, stagedModelChoices } from "../src/desktop/renderer/src/components/settings/providerModelProjection.js";
import { thinkingLabel as composerThinkingLabel } from "../src/desktop/renderer/src/components/composer/composerLabels.js";
import { DESKTOP_COMPOSER_COMMAND_NAMES, buildDesktopComposerItems } from "../src/desktop/renderer/src/components/composer/desktopSlashCommands.js";
import { highlightFencedCode, highlightWorkspaceFile } from "../src/desktop/renderer/src/syntaxHighlight.js";
import { splitAttachmentReferences, withAttachmentReferences } from "../src/desktop/attachmentReferences.js";
import { workspaceFileMarker } from "../src/desktop/renderer/src/workspaceFileMarker.js";
import { filterPickerModelChoices, listConfiguredModelChoices, listModelChoices, listPickerModelChoices, ModelManager } from "../src/llm/ModelManager.js";
import { FileModelsStore } from "../src/llm/ModelsStore.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { listSessionSummaries, readStoredSessionEvents } from "../src/session/events.js";
import { agentDir, ensureAgentDirs, resolveSessionFile, sessionFilePath } from "../src/session/store.js";
import type { AgentMessage } from "../src/agent/core/types.js";
import { TurnStore } from "../src/session/turnStore.js";

const execFileAsync = promisify(execFile);

await testInteractiveRuntimeProtocol();
await testInteractiveRuntimePersistsBeforeGenerating();
await testInteractiveRuntimePublishesRunStartedBeforeSkillRefresh();
await testInteractiveRuntimePublishesStatusSnapshot();
await testInteractiveRuntimeRedactsToolEvents();
await testInteractiveRuntimeRedactsRunText();
await testInteractiveRuntimeStrongConfirmation();
await testPermissionRequiredToolResultIsFailed();
await testInteractiveRuntimeAbort();
await testInteractiveRuntimeTerminalStatuses();
await testDraftSessionsDoNotReachTheSessionList();
await testDesktopSafeStorageCredentialStore();
await testDesktopRestoresPersistedTerminalStatus();
await testDesktopPinAfterOpeningSessionUsesFreshRevision();
await testDesktopOpenSessionSkipsGlobalSessionScan();
await testDesktopOpenSessionReturnsHistoryWhenRuntimeFails();
await testDesktopOpenSessionReturnsWriterConflictReadOnlyDocument();
await testDesktopOpenSessionReturnsConsistentMetadataSnapshot();
await testDesktopRuntimeInitializationIsShared();
await testDesktopMessageEditFork();
await testDesktopPromptIdempotency();
await testDesktopClearsTerminalLiveEvents();
await testWorkspaceFilePreview();
await testWorkspaceDirectoryListing();
await testDesktopGitInspectionDisablesHelpers();
await testDesktopGitBranches();
await testWorkspaceSyntaxHighlighting();
await testFencedCodeHighlighting();
testAttachmentReferenceRoundTrip();
await testInlineImageReading();
testDesktopComposerSlashItems();
testWorkspaceFileMarkers();
await testFilePanelSizing();
await testSidebarSizing();
testSidebarLayoutState();
await testDesktopThemePreference();
await testDesktopActiveViewPersistence();
await testDesktopDragRegionStyles();
await testDesktopUserMessageEnterDoesNotShadowFullRow();
await testDesktopMemoryFlatStoreCas();
await testDesktopSettingsTransaction();
await testDesktopToolModelSelection();
await testDesktopGlobalWriteGateAndRuntimeRefresh();
await testDesktopSettingsSaveReturnsBeforeRuntimeRefresh();
await testDesktopGlobalPersonalizationRefreshesInBackground();
await testDesktopSettingsCredentialLifecycle();
await testDesktopModelConfiguration();
await testDesktopCustomProviderConnection();
await testDesktopModelSwitchDoesNotResumeInterruptedTurn();
await testDesktopModelSwitchDoesNotStartDetachedHost();
await testDesktopSubagentSlashCommands();
await testDesktopDoesNotResumePersistedIdleSession();
await testDesktopPermissionModePersistsInIdleSnapshot();
await testDesktopPermissionModePersistsThroughExistingHost();
await testDesktopReconcilesPersistedPermissionWithExistingHost();
await testDesktopMemoryChangesKeepPermissionMode();
await testDesktopCredentialsAreSeparated();
await testDesktopWebSearchSettings();
await testDesktopPersonalizationCasAndChatOverride();
await testDesktopRequiresModelConfiguration();
await testDesktopConnectionMetadata();
await testDesktopCodexLoginCallbackLifecycle();
await testDesktopOAuthCommitSurvivesCatalogFailure();
await testWorkspaceSnapshotDoesNotReorderProjects();
await testDesktopNavigationReadsDoNotPersistSelection();
await testDesktopSidebarListsEveryProjectSession();
await testDesktopProjectReorder();
testProviderCatalogResolution();
testSettingsModelThinkingProjection();
testComposerThinkingLabels();
testModelChoicesDeduplicateEquivalentAliases();
testHistoricalAbortProjection();
testHistoricalUsageProjection();
testMessageVersionTimelineProjection();
testLiveRetryReplacesTargetTurn();
testDesktopUsagePresentation();
testHistoricalToolProjection();
testMemoryMetadataStaysOutOfTimeline();
testWebSearchProjection();
testHistoricalReasoningAndSkillProjection();
testExecutionTimelineKeepsReasoningAndToolsInOrder();
testLiveExecutionTimelineKeepsReasoningAndToolsInOrder();
testLiveAssistantCompletionDoesNotDuplicateDelta();
testVerifierPromptIsNotRenderedAsUserMessage();
testHistoricalPrefixKeepsUnpersistedDuplicatePrompt();
testHistoricalEmptyAssistantDoesNotEraseReply();
testChangedFileProjection();
testLiveTimelineProjection();
testLiveTimelineCoalescesReasoningDeltas();
testLiveBlockedAndCancelledProjection();
testTerminalRunEventClassification();
testLiveReasoningAndSkillProjection();
testReasoningDetailDoesNotUseCompletionStatusAsContent();
testDesktopNavigationHistory();
testDesktopRendererStateProjection();
testDesktopRendererSidebarProjection();
testDesktopRendererRootRefreshDropsDeletedSession();
testDesktopRendererProjectOrder();

async function testDesktopDragRegionStyles(): Promise<void> {
  const css = await readFile(new URL("../src/desktop/renderer/src/styles/biny.css", import.meta.url), "utf8");
  const toolbar = css.match(/\.biny-chat-toolbar\s*\{(?<body>[^}]*)\}/)?.groups?.body;
  const scroll = css.match(/\.biny-chat-scroll\s*\{(?<body>[^}]*)\}/)?.groups?.body;

  assert.ok(toolbar, "聊天工具栏样式必须存在");
  assert.match(toolbar, /-webkit-app-region:\s*drag;/, "聊天工具栏必须保留原生窗口拖动区");
  assert.ok(scroll, "聊天滚动层样式必须存在");
  assert.doesNotMatch(scroll, /(?:-webkit-)?app-region:\s*no-drag;/, "全高滚动层不能覆盖顶部窗口拖动区");
}

async function testDesktopUserMessageEnterDoesNotShadowFullRow(): Promise<void> {
  const css = await readFile(new URL("../src/desktop/renderer/src/styles/chat.css", import.meta.url), "utf8");
  const animationStart = css.indexOf("@keyframes chat-user-message-enter");
  const animationEnd = css.indexOf("@keyframes chat-user-sheen", animationStart);

  assert.ok(animationStart >= 0 && animationEnd > animationStart, "用户消息入场动画必须存在");
  // 复刻参考应用 userMessageFloatIn（含阴影帧）：阴影只允许出现在气泡动画里，
  // 通栏消息行选择器不得携带该动画，否则发送首帧会在整个聊天区闪出横向暗带。
  assert.match(css.slice(animationStart, animationEnd), /box-shadow\s*:/, "气泡入场动画应包含原文阴影帧");
  const bubbleRule = /\.biny-chat-scroll \.user-message\.is-pending-entry \.user-bubble,/.exec(css);
  assert.ok(bubbleRule, "入场动画必须挂在 .user-bubble 上");
  const rowRule = css.match(/\.biny-chat-scroll \.user-message\.is-pending-entry,\s*\n\.biny-chat-scroll \.timeline-turn\.is-running > \.user-message,/);
  assert.equal(rowRule, null, "通栏用户消息行不得携带入场动画");
}

async function testInteractiveRuntimeProtocol(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let resolvePermission!: (event: Extract<AgentHostEvent, { type: "permission.requested" }>) => void;
  const permissionRequested = new Promise<Extract<AgentHostEvent, { type: "permission.requested" }>>((resolve) => {
    resolvePermission = resolve;
  });
  subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "permission.requested") resolvePermission(event);
  });

  const submitted = runtime.submitPrompt("modify file");
  const permission = await permissionRequested;
  assert.equal(permission.toolCallId, "tool-1");
  runtime.answerPermission(permission.requestId, { approved: true, action: "allow_once", scope: "once", confirmation: undefined });
  await submitted.completion;

  assert.deepEqual(events.map((event) => event.type), [
    "message.user",
    "run.started",
    "reasoning.started",
    "reasoning.completed",
    "tool.started",
    "permission.requested",
    "permission.resolved",
    "tool.completed",
    "assistant.delta",
    "assistant.completed",
    "context.updated",
    "run.completed"
  ]);
  assert.ok(events.every((event) => event.sessionId === "session-1" && event.runId && event.timestamp));
  const resolved = events.find((event): event is Extract<AgentHostEvent, { type: "permission.resolved" }> => event.type === "permission.resolved");
  assert.equal(resolved?.action, "allow_once");
  await runtime.close();
}

async function testInteractiveRuntimePersistsBeforeGenerating(): Promise<void> {
  const commandRuntime = fakeCommandRuntime();
  let admitted = false;
  commandRuntime.agent.admitUserMessage = async () => { admitted = true; };
  const runtime = new InteractiveAgentRuntime(commandRuntime);
  const events: AgentHostEvent[] = [];
  const unsubscribe = subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "message.user" || event.type === "run.started") {
      assert.equal(admitted, true, `${event.type} must follow durable user admission`);
    }
  });
  const submitted = runtime.submitPrompt("status-snapshot");
  await submitted.completion;
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["message.user", "run.started"]);
  unsubscribe();
  await runtime.close();
}

async function testInteractiveRuntimePublishesRunStartedBeforeSkillRefresh(): Promise<void> {
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const commandRuntime = fakeCommandRuntime();
  commandRuntime.refreshSkills = async (): Promise<void> => await refresh;
  const runtime = new InteractiveAgentRuntime(commandRuntime);
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const events: AgentHostEvent[] = [];
  const unsubscribe = subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "run.started") notifyStarted();
  });

  const submitted = runtime.submitPrompt("status-snapshot");
  await started;
  assert.deepEqual(events.map((event) => event.type), ["message.user", "run.started"]);
  assert.equal(events.some((event) => event.type === "run.started"), true);
  releaseRefresh();
  await submitted.completion;
  unsubscribe();
  await runtime.close();
}

function testDesktopRendererStateProjection(): void {
  const project = desktopRendererProject("project-a", "Project A");
  const workspace: DesktopWorkspaceSnapshot = {
    project,
    sessions: [],
    selectedSessionId: undefined,
    runtime: undefined,
    runtimeError: undefined,
    permissionMode: "ask",
    requiresModelConfiguration: false,
    pickerModels: [],
    models: [],
    connections: []
  };
  const timestamp = "2026-08-03T10:00:00.000Z";
  const runningSnapshot: DesktopAgentEventEnvelope["snapshot"] = {
    revision: 1,
    info: {} as DesktopAgentEventEnvelope["snapshot"]["info"],
    permissionMode: "ask",
    state: {
      kind: "runs",
      activeRun: {
        sessionId: "session-a",
        runId: "run-a",
        messageId: "message-a",
        input: "Refactor the desktop renderer",
        status: "thinking",
        startedAt: timestamp
      }
    }
  };
  const idleSnapshot: DesktopAgentEventEnvelope["snapshot"] = {
    ...runningSnapshot,
    revision: 2,
    state: { kind: "idle" }
  };
  const projected = applyUpdatesToWorkspace(workspace, [
    {
      projectId: project.id,
      snapshot: runningSnapshot,
      event: {
        type: "message.user",
        sessionId: "session-a",
        runId: "run-a",
        timestamp,
        messageId: "message-a",
        content: "Refactor the desktop renderer"
      }
    },
    {
      projectId: project.id,
      snapshot: idleSnapshot,
      event: {
        type: "run.blocked",
        sessionId: "session-a",
        runId: "run-a",
        timestamp: "2026-08-03T10:00:05.000Z",
        durationMs: 5_000,
        reason: "missing_user_input",
        summary: "Need a target",
        resumable: true
      }
    }
  ]);

  assert.equal(projected.sessions.length, 1);
  assert.equal(projected.sessions[0]?.title, "Refactor the desktop renderer");
  assert.equal(projected.sessions[0]?.status, "blocked");
  assert.equal(projected.sessions[0]?.resumable, true);
  assert.equal(projected.runtime?.revision, 2);
  const staleRuntime = applyUpdatesToWorkspace(
    { ...workspace, permissionMode: "full-access" },
    [{
      projectId: project.id,
      snapshot: { ...idleSnapshot, permissionMode: "ask" },
      event: {
        type: "run.blocked",
        sessionId: "session-a",
        runId: "run-a",
        timestamp: "2026-08-03T10:00:05.000Z",
        durationMs: 5_000,
        reason: "missing_user_input",
        summary: "Need a target",
        resumable: true
      }
    }]
  );
  assert.equal(staleRuntime.permissionMode, "full-access");
  const previousSessionInfo = { sessionId: "session-previous" } as DesktopAgentEventEnvelope["snapshot"]["info"];
  const targetSessionInfo = { sessionId: "session-target" } as DesktopAgentEventEnvelope["snapshot"]["info"];
  const rebindingMaintenance = {
    ...runningSnapshot,
    info: previousSessionInfo,
    state: { kind: "maintenance", operation: "resume" as const }
  };
  const rebindingIdle = {
    ...rebindingMaintenance,
    revision: 3,
    info: targetSessionInfo,
    state: { kind: "idle" as const }
  };
  const rebound = applyUpdatesToWorkspace(
    {
      ...workspace,
      runtime: rebindingMaintenance,
      sessionRuntimes: { [previousSessionInfo.sessionId]: rebindingMaintenance }
    },
    [
      { projectId: project.id, sessionId: previousSessionInfo.sessionId, primary: true, snapshot: rebindingMaintenance },
      { projectId: project.id, sessionId: targetSessionInfo.sessionId, primary: true, snapshot: rebindingIdle }
    ]
  );
  assert.equal(rebound.sessionRuntimes?.[previousSessionInfo.sessionId], undefined);
  assert.equal(rebound.sessionRuntimes?.[targetSessionInfo.sessionId]?.state.kind, "idle");
  assert.equal(Object.values(rebound.sessionRuntimes ?? {}).some((snapshot) => snapshot.state.kind !== "idle"), false);
  const switched = updateRuntimeInfo(projected, {
    modelAlias: "deepseek-v4-flash",
    provider: "deepseek",
    modelLabel: "deepseek-v4-flash",
    reasoningLabel: "High",
    thinking: "high",
    contextWindow: 1_000_000,
    maxInputTokens: 950_000
  });
  assert.equal(switched.runtime?.info.modelAlias, "deepseek-v4-flash");
  assert.equal(switched.runtime?.info.contextWindow, 1_000_000);
  assert.equal(switched.runtime?.info.maxInputTokens, 950_000);

  const withoutRuntime: DesktopWorkspaceSnapshot = {
    ...workspace,
    models: [{ alias: "old-model" }, { alias: "deepseek-v4-flash" }] as DesktopWorkspaceSnapshot["models"],
    pickerModels: [{ alias: "old-model" }, { alias: "deepseek-v4-flash" }] as DesktopWorkspaceSnapshot["pickerModels"]
  };
  const switchedBeforeRuntime = updateRuntimeInfo(withoutRuntime, {
    modelAlias: "deepseek-v4-flash",
    provider: "deepseek",
    modelLabel: "deepseek-v4-flash",
    reasoningLabel: "High",
    thinking: "high"
  });
  assert.equal(switchedBeforeRuntime.runtime, undefined);
  assert.equal(switchedBeforeRuntime.models[0]?.alias, "deepseek-v4-flash");
  assert.equal(switchedBeforeRuntime.pickerModels[0]?.alias, "deepseek-v4-flash");
}

function testDesktopRendererSidebarProjection(): void {
  const existing = desktopRendererSession("project-a", "session-a", "Existing task");
  const timestamp = "2026-08-03T10:10:00.000Z";
  const snapshot: DesktopAgentEventEnvelope["snapshot"] = {
    revision: 1,
    info: {} as DesktopAgentEventEnvelope["snapshot"]["info"],
    permissionMode: "ask",
    state: { kind: "idle" }
  };
  const projected = applyUpdatesToSidebarSessions([existing], [{
    projectId: "project-b",
    snapshot,
    event: {
      type: "message.user",
      sessionId: "session-b",
      runId: "run-b",
      timestamp,
      messageId: "message-b",
      content: "Task in another project"
    }
  }]);

  assert.strictEqual(projected.find((session) => session.id === existing.id), existing);
  const otherProjectSession = projected.find((session) => session.projectId === "project-b");
  assert.equal(otherProjectSession?.title, "Task in another project");
  assert.equal(otherProjectSession?.status, "running");

  const replacement = { ...otherProjectSession!, title: "Renamed task", pinned: true };
  const replaced = replaceProjectSessions(projected, "project-b", [replacement]);
  assert.equal(replaced.filter((session) => session.projectId === "project-b").length, 1);
  assert.equal(replaced.find((session) => session.projectId === "project-b")?.title, "Renamed task");
  assert.ok(replaced.includes(existing));
}

function testDesktopRendererRootRefreshDropsDeletedSession(): void {
  const root = desktopRendererSession("project-a", "root", "Root task");
  const child = {
    ...desktopRendererSession("project-a", "child", "Fork task"),
    parentSessionId: root.id
  };
  const deleted = {
    ...desktopRendererSession("project-a", "deleted", "Deleted fork"),
    parentSessionId: root.id
  };
  const otherProject = desktopRendererSession("project-b", "other", "Other task");
  const refreshedRoot = { ...root, title: "Root task (updated)" };

  const projected = replaceProjectSessionRoots(
    [root, child, deleted, otherProject],
    "project-a",
    [refreshedRoot],
    [refreshedRoot, child]
  );

  assert.deepEqual(projected.map((session) => session.id), ["root", "child", "other"]);
  assert.equal(projected.find((session) => session.id === "root")?.title, "Root task (updated)");
}

function testDesktopRendererProjectOrder(): void {
  const first = desktopRendererProject("project-a", "Project A");
  const second = desktopRendererProject("project-b", "Project B");
  const ordered = applyProjectOrder([first, second], [second.id, second.id, "missing"]);
  assert.deepEqual(ordered.map((project) => project.id), [second.id, first.id]);
}

function desktopRendererProject(id: string, name: string): DesktopProject {
  return {
    id,
    path: `/tmp/${id}`,
    name,
    branch: "main",
    dirty: false,
    missing: false,
    pinned: false,
    addedAt: "2026-08-03T09:00:00.000Z",
    lastOpenedAt: "2026-08-03T09:00:00.000Z"
  };
}

function desktopRendererSession(projectId: string, id: string, title: string): DesktopSessionSummary {
  return {
    id,
    projectId,
    fileName: `${id}.jsonl`,
    title,
    firstUserMessage: title,
    lastAssistantMessage: "",
    eventCount: 1,
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: "2026-08-03T09:00:00.000Z",
    pinned: false,
    status: "idle",
    resumable: undefined
  };
}

async function testInteractiveRuntimePublishesStatusSnapshot(): Promise<void> {
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime(false, statusGate));
  let sawCompletedStatus = false;
  runtime.subscribe((update) => {
    if (update.snapshot.state.kind === "runs" && update.snapshot.state.activeRun.status === "completed") {
      sawCompletedStatus = true;
    }
  });

  const submitted = runtime.submitPrompt("status-snapshot");
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(sawCompletedStatus, false, "terminal UI state must wait for the canonical commit");
  } finally {
    releaseStatus();
    await submitted.completion;
    assert.equal(sawCompletedStatus, false, "terminal host events should close the active run instead of exposing a stale terminal snapshot");
    await runtime.close();
  }
}

async function testInteractiveRuntimeRedactsToolEvents(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "permission.requested") {
      runtime.answerPermission(event.requestId, { approved: true, scope: "once" });
    }
  });

  await runtime.submitPrompt("secret").completion;
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("opaque-live-tool-secret"), false);
  assert.match(serialized, /\[redacted\]/);
  const started = events.find((event): event is Extract<AgentHostEvent, { type: "tool.started" }> => event.type === "tool.started");
  const completed = events.find((event): event is Extract<AgentHostEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  assert.equal((started?.args as { apiKey?: string } | undefined)?.apiKey, "[redacted]");
  assert.equal((completed?.result as { safe?: string } | undefined)?.safe, "visible");
  await runtime.close();
}

async function testInteractiveRuntimeRedactsRunText(): Promise<void> {
  for (const input of ["secret-event-error", "secret-thrown-error"]) {
    const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
    const events: AgentHostEvent[] = [];
    subscribeHostEvents(runtime, (event) => events.push(event));
    const outcome = await runtime.submitPrompt(input).completion;
    const serialized = JSON.stringify({ events, outcome });
    assert.equal(serialized.includes("opaque-live-run-secret"), false);
    assert.match(serialized, /\[redacted\]/);
    assert.equal(events.some((event) => event.type === "run.failed"), true);
    await runtime.close();
  }

  const services = fakeCommandRuntime();
  const runtime = new InteractiveAgentRuntime(services);
  const events: AgentHostEvent[] = [];
  subscribeHostEvents(runtime, (event) => events.push(event));
  await assert.rejects(
    executeRuntimeCommand(runtime, services, "/subagent secret-subagent-failure", "desktop"),
    /\[redacted\]/
  );
  assert.equal(JSON.stringify(events).includes("opaque-live-run-secret"), false);
  await runtime.close();
}

async function testInteractiveRuntimeStrongConfirmation(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime(true));
  let resolvePermission!: (event: Extract<AgentHostEvent, { type: "permission.requested" }>) => void;
  const permissionRequested = new Promise<Extract<AgentHostEvent, { type: "permission.requested" }>>((resolve) => {
    resolvePermission = resolve;
  });
  subscribeHostEvents(runtime, (event) => {
    if (event.type === "permission.requested") resolvePermission(event);
  });

  const submitted = runtime.submitPrompt("modify critical file");
  const permission = await permissionRequested;
  assert.equal(permission.request.requireFullYes, true);
  assert.throws(
    () => runtime.answerPermission(permission.requestId, { approved: true, scope: "once" }),
    /requires the full word yes/u
  );
  assert.equal(pendingPermission(runtime.getSnapshot())?.requestId, permission.requestId);
  assert.throws(
    () => runtime.answerPermission(permission.requestId, { approved: true, scope: "once", confirmation: "y" }),
    /requires the full word yes/u
  );
  runtime.answerPermission(permission.requestId, { approved: true, scope: "once", confirmation: " YES " });
  assert.equal((await submitted.completion).status, "completed");
  await runtime.close();
}

async function testPermissionRequiredToolResultIsFailed(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "permission.requested") {
      runtime.answerPermission(event.requestId, { approved: true, scope: "once" });
    }
  });

  await runtime.submitPrompt("stale").completion;
  assert.equal(events.some((event) => event.type === "tool.failed" && /target changed/i.test(event.error)), true);
  assert.equal(events.some((event) => event.type === "tool.completed"), false);
  await runtime.close();
}

async function testInteractiveRuntimeAbort(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let started!: () => void;
  const runStarted = new Promise<void>((resolve) => { started = resolve; });
  subscribeHostEvents(runtime, (event) => {
    events.push(event);
    if (event.type === "run.started") started();
  });
  const submitted = runtime.submitPrompt("cancel");
  await runStarted;
  runtime.cancelCurrentRun("interrupted");
  await submitted.completion;
  assert.equal(events.at(-1)?.type, "run.cancelled");
  await runtime.close();
}

async function testInteractiveRuntimeTerminalStatuses(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  subscribeHostEvents(runtime, (event) => events.push(event));

  const blocked = await runtime.submitPrompt("terminal-blocked").completion;
  assert.equal(blocked.status, "blocked");
  assert.equal(events.at(-1)?.type, "run.blocked");
  assert.equal(events.some((event) => event.type === "run.completed" && event.runId === blocked.runId), false);

  const incomplete = await runtime.submitPrompt("terminal-incomplete").completion;
  assert.equal(incomplete.status, "incomplete");
  assert.equal(events.at(-1)?.type, "run.incomplete");
  assert.equal(events.some((event) => event.type === "run.completed" && event.runId === incomplete.runId), false);
  await runtime.close();
}

async function testDraftSessionsDoNotReachTheSessionList(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-draft-session-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const draft = new SessionRecorder(workspaceRoot, "draft");
    await access(draft.filePath);
    await assert.rejects(resolveSessionFile(workspaceRoot, "latest"), /No sessions found/);
    await draft.close();
    await assert.rejects(access(draft.filePath));
    await writeFile(sessionFilePath(workspaceRoot, "legacy-empty"), "");
    await writeFile(sessionFilePath(workspaceRoot, "legacy-error"), `${JSON.stringify({ type: "error", message: "No model available" })}\n`);
    assert.deepEqual(await listSessionSummaries(workspaceRoot), []);

    const activeDraft = new SessionRecorder(workspaceRoot, "draft");
    activeDraft.record({ type: "user_message", content: "Create a project" });
    await activeDraft.close();
    assert.deepEqual((await listSessionSummaries(workspaceRoot)).map((session) => session.fileName), ["draft.jsonl"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSafeStorageCredentialStore(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-safestorage-"));
  try {
    // 注入一个内存 cipher：模拟 safeStorage 的 encrypt/decrypt（反转字符串做可逆伪加密），
    // 验证存储的往返、持久化文件与跨实例读取，而不依赖真实 Keychain。
    const cipher: SafeStorageCipher = {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
      decrypt: (payload) => payload.toString("utf8").split("").reverse().join("")
    };
    const store = new DesktopSafeStorageCredentialStore(root, () => cipher);
    assert.equal(await store.get("provider:deepseek:apiKey"), undefined);
    await store.set("provider:deepseek:apiKey", "sk-live-secret");
    assert.equal(await store.get("provider:deepseek:apiKey"), "sk-live-secret");
    // 落盘的是密文，不是明文。
    const onDisk = await readFile(path.join(root, "credentials.enc"), "utf8");
    assert.ok(!onDisk.includes("sk-live-secret"), "凭据文件不得包含明文密钥");
    // 新实例（模拟重启）能从加密文件读回，证明持久化有效。
    const reopened = new DesktopSafeStorageCredentialStore(root, () => cipher);
    assert.equal(await reopened.get("provider:deepseek:apiKey"), "sk-live-secret");
    await reopened.delete("provider:deepseek:apiKey");
    assert.equal(await reopened.get("provider:deepseek:apiKey"), undefined);
    // 加密不可用时要明确报错，而不是静默失败。
    const unavailable = new DesktopSafeStorageCredentialStore(root, () => ({ ...cipher, isAvailable: () => false }));
    await assert.rejects(unavailable.set("provider:x:apiKey", "v"), /加密存储不可用/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopRestoresPersistedTerminalStatus(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-status-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-status-data-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "terminal-status");
    recorder.record({ type: "user_message", content: "deploy the project" });
    recorder.record({ type: "assistant_message", content: "I need the target environment." });
    recorder.record({
      type: "turn_status",
      status: "blocked",
      stopReason: "blocked",
      steps: 1,
      summary: "The target environment is unknown.",
      resumable: true,
      blockedReason: "missing_user_input",
      requiredAction: "Choose staging or production.",
      affectedTodoIds: ["deploy"]
    });
    recorder.record({ type: "user_message", content: "Use staging." });
    recorder.record({ type: "assistant_message", content: "The deployment is not finished." });
    recorder.record({
      type: "turn_status",
      status: "incomplete",
      stopReason: "hard_step_limit",
      steps: 96,
      summary: "The hard step limit was reached.",
      resumable: true
    });
    await recorder.close();

    const sessions = await projects.listSessions(project, undefined, new Map());
    const restored = sessions.find((session) => session.id === "terminal-status");
    assert.equal(restored?.status, "incomplete");
    assert.equal(restored?.resumable, true);

    const document = await projects.openSession(project, "terminal-status", undefined, new Map());
    const timeline = buildSessionTimeline(document.events, document.liveEvents);
    assert.equal(timeline[0]?.status, "blocked");
    assert.equal(timeline[0]?.resumable, true);
    assert.match(timeline[0]?.error ?? "", /Choose staging or production/u);
    assert.equal(timeline[1]?.status, "incomplete");
    assert.equal(timeline[1]?.resumable, true);
    assert.match(timeline[1]?.error ?? "", /hard step limit/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopMessageEditFork(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-edit-fork-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-edit-fork-data-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const source = new SessionRecorder(dataRoot, "source-session");
    const first = source.record({ type: "user_message", content: "第一条" });
    source.record({ type: "assistant_message", content: "第一条回复" });
    source.record({ type: "user_message", content: "审计输入", auditOnly: true });
    source.record({ type: "assistant_message", content: "审计输出", auditOnly: true });
    source.record({ type: "user_message", content: "旧的第二条" });
    source.record({ type: "assistant_message", content: "旧的第二条回复" });
    await source.close();

    const seededAuthority = await RuntimeEventAuthority.open(dataRoot);
    seededAuthority.close();

    const duplicatedSessionId = await projects.duplicateSession(project, "source-session");
    const duplicated = await readStoredSessionEvents(dataRoot, duplicatedSessionId);
    assert.notEqual(duplicated.events[0]?.runtime?.eventId, first.runtime?.eventId);

    const reopenedAuthority = await RuntimeEventAuthority.open(dataRoot);
    reopenedAuthority.close();

    const forkedSessionId = await projects.forkSessionAtUserMessage(project, "source-session", 1);
    const forked = await readStoredSessionEvents(dataRoot, forkedSessionId);
    assert.deepEqual(forked.events.filter((event) => event.type === "user_message" && !event.auditOnly).map((event) => event.content), ["第一条"]);
    assert.equal(forked.events.some((event) => event.type === "user_message" && event.content === "旧的第二条"), false);
    assert.equal(forked.events.some((event) => event.type === "user_message" && event.auditOnly), true);
    assert.equal(forked.events.find((event) => event.type === "user_message" && !event.auditOnly)?.runtime?.eventId === first.runtime?.eventId, false);
    assert.notEqual(forked.events[0]?.runtime?.eventId, first.runtime?.eventId);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopPromptIdempotency(): Promise<void> {
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-prompt-idempotency-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const receipt = { sessionId: "session-1", runId: "run-1", messageId: "message-1" } as const;
    const internals = agents as unknown as {
      sendPromptOnce: () => Promise<typeof receipt>;
      editPromptOnce: () => Promise<typeof receipt>;
    };
    let executions = 0;
    const executeOnce = async (): Promise<typeof receipt> => {
      executions += 1;
      await Promise.resolve();
      return receipt;
    };
    internals.sendPromptOnce = executeOnce;
    internals.editPromptOnce = executeOnce;

    const firstSend = agents.sendPrompt("project-1", undefined, "相同消息", [], undefined, undefined, "send-key");
    const secondSend = agents.sendPrompt("project-1", undefined, "相同消息", [], undefined, undefined, "send-key");
    assert.deepEqual(await Promise.all([firstSend, secondSend]), [receipt, receipt]);
    assert.equal(executions, 1, "同一发送操作键只能执行一次");

    const firstEdit = agents.editPrompt("project-1", "session-1", 0, "相同消息", [], "edit-key");
    const secondEdit = agents.editPrompt("project-1", "session-1", 0, "相同消息", [], "edit-key");
    assert.deepEqual(await Promise.all([firstEdit, secondEdit]), [receipt, receipt]);
    assert.equal(executions, 2, "同一编辑操作键只能执行一次");

    let failedExecutions = 0;
    internals.sendPromptOnce = async (): Promise<typeof receipt> => {
      failedExecutions += 1;
      throw new Error("模拟发送失败");
    };
    const failedSend = agents.sendPrompt("project-1", undefined, "失败消息", [], undefined, undefined, "failed-key");
    await assert.rejects(failedSend, /模拟发送失败/u);
    await assert.rejects(
      agents.sendPrompt("project-1", undefined, "失败消息", [], undefined, undefined, "failed-key"),
      /模拟发送失败/u
    );
    assert.equal(failedExecutions, 1, "失败操作的重复 IPC 也不能再次执行");
  } finally {
    await agents?.closeAll();
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopClearsTerminalLiveEvents(): Promise<void> {
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-live-events-data-"));
  let runtime: InteractiveAgentRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
    const internals = agents as unknown as {
      wireRuntimeEvents(projectId: string, runtime: InteractiveAgentRuntime, primary: boolean): () => void;
      projectEvents(projectId: string): Map<string, AgentHostEvent[]>;
    };
    unsubscribe = internals.wireRuntimeEvents("project-1", runtime, true);
    const submitted = runtime.submitPrompt("status-snapshot");
    await submitted.completion;
    assert.equal(internals.projectEvents("project-1").has("session-1"), false, "终态后不能继续保留已落盘的 live events");
    await agents.closeAll();
  } finally {
    unsubscribe?.();
    await runtime?.close();
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopPinAfterOpeningSessionUsesFreshRevision(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-pin-revision-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-pin-revision-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "running-session");
    recorder.record({ type: "user_message", content: "keep this task visible" });
    await recorder.close();

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const document = await agents.openSession(project.id, "running-session");
    assert.equal(document.session.unread, false, "opening a session should clear unread state optimistically");
    await agents.pinSession(project.id, "running-session", true, document.session.metadataRevision);

    const pinned = (await projects.listSessions(project, undefined, new Map())).find((session) => session.id === "running-session");
    assert.equal(pinned?.pinned, true);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopOpenSessionSkipsGlobalSessionScan(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-single-session-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-single-session-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "single-session");
    recorder.record({ type: "user_message", content: "只打开目标会话" });
    await recorder.close();

    projects.listSessions = async () => {
      throw new Error("openSession must not scan every session");
    };
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const document = await agents.openSession(project.id, recorder.sessionId);
    assert.equal(document.session.id, recorder.sessionId);
    await agents.markSessionRead(project.id, recorder.sessionId, document.session.metadataRevision);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopOpenSessionReturnsHistoryWhenRuntimeFails(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-runtime-error-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-runtime-error-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    configStore.supportsDetachedRuntimeHost = false;
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const first = new SessionRecorder(dataRoot, "runtime-error-first");
    first.record({ type: "user_message", content: "历史请求一" });
    first.record({ type: "assistant_message", content: "历史回复一" });
    await first.close();
    const second = new SessionRecorder(dataRoot, "runtime-error-second");
    second.record({ type: "user_message", content: "历史请求二" });
    second.record({ type: "assistant_message", content: "历史回复二" });
    await second.close();

    const brokenConfig = structuredClone(defaultConfig);
    brokenConfig.defaultModel = "broken-model";
    brokenConfig.providers = {
      broken: { type: "openai-compatible", baseUrl: "https://broken.example/v1" }
    };
    brokenConfig.models = {
      "broken-model": { provider: "broken", model: "broken-model", contextWindow: 128_000 }
    };
    brokenConfig.thinking = { enabled: false, effort: "high" };
    await configStore.save(brokenConfig);

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const firstDocument = await agents.openSession(project.id, first.sessionId);
    assert.equal(firstDocument.events.some((event) => event.type === "assistant_message" && event.content === "历史回复一"), true);
    assert.match(firstDocument.runtimeError ?? "", /credentials|credential|key|密钥/iu);

    const secondDocument = await agents.openSession(project.id, second.sessionId);
    assert.equal(secondDocument.events.some((event) => event.type === "assistant_message" && event.content === "历史回复二"), true);
    assert.match(secondDocument.runtimeError ?? "", /credentials|credential|key|密钥/iu);

    const workspace = await agents.workspaceSnapshot(project.id);
    assert.equal(workspace.runtime, undefined);
    assert.match(workspace.runtimeError ?? "", /credentials|credential|key|密钥/iu);
    await assert.rejects(
      agents.sendPrompt(project.id, second.sessionId, "继续", []),
      /credentials|credential|key|密钥/iu
    );
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopOpenSessionReturnsWriterConflictReadOnlyDocument(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-writer-conflict-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-writer-conflict-data-"));
  let owner: SessionLeaseStore | undefined;
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "writer-conflict-session");
    recorder.record({ type: "user_message", content: "仍然可以读取历史" });
    recorder.record({ type: "assistant_message", content: "只读正文" });
    await recorder.close();

    owner = await SessionLeaseStore.open(dataRoot);
    owner.acquire(recorder.sessionId);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const conflictDocument = await agents.openSession(project.id, recorder.sessionId);
    assert.equal(conflictDocument.writerConflict?.sessionId, recorder.sessionId);
    assert.equal(conflictDocument.events.some((event) => event.type === "assistant_message"), true);

    owner.close();
    owner = undefined;
    const retriedDocument = await agents.openSession(project.id, recorder.sessionId);
    assert.equal(retriedDocument.writerConflict, undefined);
  } finally {
    await agents?.closeAll();
    owner?.close();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopOpenSessionReturnsConsistentMetadataSnapshot(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-metadata-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-open-metadata-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const recorder = new SessionRecorder(dataRoot, "metadata-session");
    recorder.record({ type: "user_message", content: "open with consistent metadata" });
    await recorder.close();
    await projects.updateSessionMetadata(project, recorder.sessionId, {
      title: "旧标题",
      pinned: false,
      unread: true,
      labels: ["旧标签"]
    });

    const markSessionRead = projects.markSessionRead.bind(projects);
    projects.markSessionRead = async (targetProject, sessionId, expectedRevision) => {
      // 模拟 openSession 已读完旧摘要后，另一窗口先提交一组新元数据。
      await projects.updateSessionMetadata(targetProject, sessionId, {
        title: "并发新标题",
        pinned: true,
        labels: ["新标签"]
      });
      return await markSessionRead(targetProject, sessionId, expectedRevision);
    };

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const document = await agents.openSession(project.id, recorder.sessionId);
    assert.equal(document.session.title, "旧标题");
    assert.equal(document.session.pinned, false);
    assert.equal(document.session.unread, false);
    await agents.markSessionRead(project.id, recorder.sessionId, document.session.metadataRevision);
    const current = (await projects.listSessions(project, undefined, new Map()))
      .find((session) => session.id === recorder.sessionId);
    assert.ok(current);
    assert.equal(current.title, "并发新标题");
    assert.equal(current.pinned, true);
    assert.equal(current.unread, false);
    assert.deepEqual(current.labels, ["新标签"]);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopRuntimeInitializationIsShared(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-initialization-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-initialization-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    configStore.supportsDetachedRuntimeHost = false;
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const internals = agents as unknown as {
      runtimes: Map<string, unknown>;
      ensureRuntime(projectId: string): Promise<unknown>;
    };
    const [first, second] = await Promise.all([
      internals.ensureRuntime(project.id),
      internals.ensureRuntime(project.id)
    ]);
    assert.equal(first, second, "concurrent Desktop requests must share one Host client initialization");
    assert.equal(internals.runtimes.size, 1);
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testWorkspaceFilePreview(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-preview-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "hello.py"), "print('hello')\n");
    assert.deepEqual(await projects.readWorkspaceFile(project, "hello.py"), {
      path: "hello.py",
      content: "print('hello')\n",
      bytes: 15,
      binary: false,
      truncated: false
    });
    await writeFile(path.join(workspaceRoot, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const binary = await projects.readWorkspaceFile(project, "image.bin");
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
    await writeFile(path.join(workspaceRoot, "large.txt"), "a".repeat(512 * 1024 + 8));
    const large = await projects.readWorkspaceFile(project, "large.txt");
    assert.equal(large.content?.length, 512 * 1024);
    assert.equal(large.truncated, true);
    await assert.rejects(projects.readWorkspaceFile(project, "../outside.txt"), /Path escapes workspace/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testWorkspaceDirectoryListing(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-directory-listing-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-directory-outside-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(path.join(workspaceRoot, "README.md"), "# Biny\n");
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");

    const root = await projects.listWorkspaceDirectory(project, ".");
    assert.equal(root.path, ".");
    assert.deepEqual(root.entries.map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind })), [
      { name: "src", path: "src", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" }
    ]);
    const nested = await projects.listWorkspaceDirectory(project, "src");
    assert.deepEqual(nested.entries.map((entry) => entry.path), ["src/index.ts"]);
    await assert.rejects(projects.listWorkspaceDirectory(project, "../outside"), /Path escapes workspace/);
    await assert.rejects(projects.listWorkspaceDirectory(project, ".git"), /ignored by workspace policy/);
    await symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "dir");
    await assert.rejects(projects.listWorkspaceDirectory(project, "outside-link"), /symbolic link/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopGitInspectionDisablesHelpers(): Promise<void> {
  if (process.platform === "win32") return;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-data-"));
  const sentinel = path.join(workspaceRoot, "fsmonitor-ran.txt");
  const helper = path.join(workspaceRoot, "fsmonitor-helper.mjs");
  try {
    await writeFile(helper, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`
    ].join("\n"), "utf8");
    await chmod(helper, 0o755);
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await execFileAsync("git", ["config", "core.fsmonitor", helper], { cwd: workspaceRoot });
    const { projects } = await createDesktopTestServices(desktopRoot);
    await projects.createProject(workspaceRoot);
    await assert.rejects(access(sentinel));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopGitBranches(): Promise<void> {
  if (process.platform === "win32") return;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-branches-"));
  const nonGitRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-non-git-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-branches-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await execFileAsync("git", ["config", "user.name", "Biny Tests"], { cwd: workspaceRoot });
    await execFileAsync("git", ["config", "user.email", "biny-tests@example.com"], { cwd: workspaceRoot });
    await writeFile(path.join(workspaceRoot, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspaceRoot });
    await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: workspaceRoot });
    const initialBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: workspaceRoot })).stdout.trim();
    assert.ok(initialBranch);
    await execFileAsync("git", ["branch", "feature/base"], { cwd: workspaceRoot });
    await execFileAsync("git", ["branch", "topic/local"], { cwd: workspaceRoot });

    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const branches = await projects.listProjectBranches(project.id);
    assert.deepEqual(
      branches.map((branch) => branch.name).sort(),
      [initialBranch, "feature/base", "topic/local"].sort()
    );
    assert.equal(branches.find((branch) => branch.current)?.name, initialBranch);

    await projects.switchProjectBranch(project.id, "feature/base");
    assert.equal((await projects.inspectProject(project)).branch, "feature/base");
    await projects.createProjectBranch(project.id, "feature/new");
    assert.equal((await projects.inspectProject(project)).branch, "feature/new");
    await assert.rejects(projects.createProjectBranch(project.id, "feature/new"), /已存在/u);
    await assert.rejects(projects.switchProjectBranch(project.id, "missing/local"), /不存在/u);
    await assert.rejects(projects.createProjectBranch(project.id, "bad..name"), /不合法/u);

    await writeFile(path.join(workspaceRoot, "README.md"), "dirty\n");
    await assert.rejects(projects.switchProjectBranch(project.id, initialBranch), /未提交改动/u);
    await writeFile(path.join(workspaceRoot, "README.md"), "initial\n");

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const switched = await agents.switchProjectBranch(project.id, initialBranch);
    assert.equal(switched.project.branch, initialBranch);
    const originalIsProjectRunning = agents.isProjectRunning;
    agents.isProjectRunning = () => true;
    await assert.rejects(
      agents.createProjectBranch(project.id, "blocked/new"),
      /运行或维护中/u
    );
    agents.isProjectRunning = originalIsProjectRunning;

    const nonGitProject = await projects.createProject(nonGitRoot);
    assert.deepEqual(await projects.listProjectBranches(nonGitProject.id), []);
    await assert.rejects(projects.switchProjectBranch(nonGitProject.id, "main"), /不是 Git/u);
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(nonGitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testWorkspaceSyntaxHighlighting(): Promise<void> {
  const highlighted = await highlightWorkspaceFile("src/index.ts", "const answer: number = 42;\n");
  assert.equal(highlighted.language, "typescript");
  // shiki 双主题：明暗两组颜色都以 CSS 变量输出，主题切换由全局 .shiki 规则完成
  assert.match(highlighted.html, /--shiki-light/);
  assert.match(highlighted.html, /--shiki-dark/);
}

async function testFencedCodeHighlighting(): Promise<void> {
  const typescript = await highlightFencedCode("const answer: number = 42;", "ts");
  assert.equal(typescript.language, "typescript");
  assert.match(typescript.html, /--shiki-light/);

  // 认不出的语言标注不高亮，但仍然要转义后交出去。
  const unknown = await highlightFencedCode("<script>alert(1)</script>", "brainfuck");
  assert.equal(unknown.language, undefined);
  assert.equal(unknown.html, "&lt;script&gt;alert(1)&lt;/script&gt;");
}

function testAttachmentReferenceRoundTrip(): void {
  const prompt = withAttachmentReferences("看下这张图", [
    { name: "shot.png", path: "@attachments/1753600000000-a1b2c3-shot.png", mimeType: "image/png", size: 2048 }
  ]);
  const split = splitAttachmentReferences(prompt);
  assert.equal(split.text, "看下这张图");
  assert.deepEqual(split.attachments, [
    { path: "@attachments/1753600000000-a1b2c3-shot.png", name: "shot.png", mimeType: "image/png", size: 2048 }
  ]);

  // 没有附件块，以及格式对不上的历史消息，都要原样返回。
  assert.deepEqual(splitAttachmentReferences("普通消息"), { text: "普通消息", attachments: [] });
  const malformed = "普通消息\n\nAttached files (read them with Read using these @attachments/ paths):\n- 说明文字";
  assert.deepEqual(splitAttachmentReferences(malformed), { text: malformed, attachments: [] });
}

async function testInlineImageReading(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-inline-image-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-inline-image-desktop-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    await writeFile(path.join(workspaceRoot, "shot.gif"), pixel);
    const attachment = await projects.saveAttachment(project, "shot.gif", "image/gif", pixel);

    assert.equal(await projects.readInlineImage(project, "shot.gif"), `data:image/gif;base64,${pixel.toString("base64")}`);
    assert.equal(await projects.readInlineImage(project, attachment.path), `data:image/gif;base64,${pixel.toString("base64")}`);
    // 非图片、越界路径和不存在的文件都只是「没图」，不能抛错打断消息渲染。
    assert.equal(await projects.readInlineImage(project, "notes.txt"), undefined);
    assert.equal(await projects.readInlineImage(project, "../outside.png"), undefined);
    assert.equal(await projects.readInlineImage(project, "@attachments/../../escape.png"), undefined);
    assert.equal(await projects.readInlineImage(project, "missing.png"), undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function testWorkspaceFileMarkers(): void {
  assert.deepEqual(workspaceFileMarker("README.md"), { label: "MD", tone: "markdown" });
  assert.deepEqual(workspaceFileMarker("src/App.tsx"), { label: "TSX", tone: "typescript" });
  assert.deepEqual(workspaceFileMarker("config.json"), { label: "{}", tone: "json" });
  assert.deepEqual(workspaceFileMarker("pnpm-lock.yaml"), { label: "YML", tone: "yaml" });
  assert.deepEqual(workspaceFileMarker(".gitignore"), { label: "◆", tone: "git" });
  assert.deepEqual(workspaceFileMarker("preview.png"), { label: "IMG", tone: "image" });
}

async function testFilePanelSizing(): Promise<void> {
  assert.equal(clampFilePanelWidth(650, 1_000), 650);
  assert.equal(clampFilePanelWidth(650, 700), 380);
  assert.equal(clampFilePanelWidth(700, 700), 380);
  assert.equal(clampFilePanelWidth(650, 1_000, 260), 420);
  assert.equal(clampFilePanelWidth(650, 900, 260), MIN_FILE_PANEL_WIDTH);
  assert.equal(clampFilePanelWidth(650, 700, 260), MIN_FILE_PANEL_WIDTH);

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-panel-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.filePanelWidth(), DEFAULT_FILE_PANEL_WIDTH);
    await state.setFilePanelWidth(600);
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.filePanelWidth(), 600);
    await restored.setFilePanelWidth(10_000);
    assert.equal(restored.filePanelWidth(), MAX_FILE_PANEL_WIDTH);
    await restored.setFilePanelWidth(1);
    assert.equal(restored.filePanelWidth(), MIN_FILE_PANEL_WIDTH);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testSidebarSizing(): Promise<void> {
  assert.equal(DEFAULT_SIDEBAR_WIDTH, 260);
  assert.equal(SIDEBAR_RAIL_WIDTH, 78);
  assert.equal(clampSidebarWidth(300), 300);
  assert.equal(clampSidebarWidth(300.4), 300);
  assert.equal(clampSidebarWidth(10), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(10_000), MAX_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(Number.NaN), DEFAULT_SIDEBAR_WIDTH);

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.sidebarWidth(), DEFAULT_SIDEBAR_WIDTH);
    await state.setSidebarWidth(320);
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.sidebarWidth(), 320);
    await restored.setSidebarWidth(10_000);
    assert.equal(restored.sidebarWidth(), MAX_SIDEBAR_WIDTH);
    await restored.setSidebarWidth(1);
    assert.equal(restored.sidebarWidth(), MIN_SIDEBAR_WIDTH);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function testSidebarLayoutState(): void {
  assert.deepEqual(resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle" }), {
    mode: "expanded",
    visualWidth: 260,
    flowWidth: 260,
    contentWidth: 260,
    transition: "idle",
    resizing: false
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "expanded", peekPhase: "idle", expandedWidth: 320, resizing: true }), {
    mode: "expanded",
    visualWidth: 320,
    flowWidth: 320,
    contentWidth: 320,
    transition: "idle",
    resizing: true
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "rail", peekPhase: "idle", expandedWidth: 320 }), {
    mode: "rail",
    visualWidth: SIDEBAR_RAIL_WIDTH,
    flowWidth: SIDEBAR_RAIL_WIDTH,
    contentWidth: SIDEBAR_RAIL_WIDTH,
    transition: "idle",
    resizing: false
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "collapsed", peekPhase: "idle" }), {
    mode: "collapsed",
    visualWidth: 0,
    flowWidth: 0,
    contentWidth: 260,
    transition: "idle",
    resizing: false
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "collapsed", peekPhase: "peeking", expandedWidth: 320 }), {
    mode: "peek",
    visualWidth: 320,
    flowWidth: 0,
    contentWidth: 320,
    transition: "idle",
    resizing: false
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "collapsed", peekPhase: "peekExited" }), {
    mode: "collapsed",
    visualWidth: 0,
    flowWidth: 0,
    contentWidth: 260,
    transition: "peek-exited",
    resizing: false
  });
  assert.deepEqual(resolveSidebarLayout({ baseMode: "collapsed", peekPhase: "pinning", expandedWidth: 320 }), {
    mode: "peek",
    visualWidth: 320,
    flowWidth: 320,
    contentWidth: 320,
    transition: "pinning",
    resizing: false
  });
}

async function testDesktopThemePreference(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-theme-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.themePreference(), "system");
    await state.setThemePreference("dark");
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.themePreference(), "dark");
    await restored.setThemePreference("light");
    assert.equal(restored.themePreference(), "light");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopActiveViewPersistence(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-active-view-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.activeView(), "chat");
    await state.setActiveView("extensions");
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.activeView(), "extensions");
    await writeFile(statePath, `${JSON.stringify({ version: 1, activeView: "mcp" })}\n`);
    const mcp = new DesktopStateStore(statePath);
    await mcp.load();
    assert.equal(mcp.activeView(), "chat");
    await writeFile(statePath, `${JSON.stringify({ version: 1, activeView: "memory" })}\n`);
    const legacy = new DesktopStateStore(statePath);
    await legacy.load();
    assert.equal(legacy.activeView(), "chat");
    await writeFile(statePath, `${JSON.stringify({ version: 1, activeView: "unknown" })}\n`);
    const migrated = new DesktopStateStore(statePath);
    await migrated.load();
    assert.equal(migrated.activeView(), "chat");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSettingsTransaction(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-transaction-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-transaction-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const settings = new DesktopSettingsTransaction(state, agents);
    const initial = await settings.snapshot(project.id);

    const conflict = await settings.save(project.id, {
      expectedPreferenceRevision: initial.preferenceRevision + 1,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark"
    });
    assert.equal(conflict.status, "rolled_back");
    if (conflict.status !== "rolled_back") throw new Error("expected rolled_back");
    assert.equal(conflict.conflicts?.[0]?.segment, "preferences");
    assert.equal(state.themePreference(), "system", "preflight conflict must not write preferences");

    const originalCommitConfig = agents.commitSettingsConfig.bind(agents);
    agents.commitSettingsConfig = async () => { throw new Error("injected config write failure"); };
    const configFailure = await settings.save(project.id, {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      themePreference: "dark",
      memory: { ...initial.memory }
    });
    assert.equal(configFailure.status, "rolled_back");
    assert.equal(state.themePreference(), "system", "config failure must compensate preferences");
    agents.commitSettingsConfig = originalCommitConfig;

    const beforeChatFailure = await settings.snapshot(project.id);
    const originalCommitChat = agents.commitSettingsChat.bind(agents);
    agents.commitSettingsChat = async () => { throw new Error("injected chat write failure"); };
    const chatFailure = await settings.save(project.id, {
      expectedPreferenceRevision: beforeChatFailure.preferenceRevision,
      expectedConfigRevision: beforeChatFailure.configRevision,
      themePreference: "dark",
      memory: { ...beforeChatFailure.memory },
      chat: {
        sessionId: "settings-draft",
        expectedMetadataRevision: "missing",
        personalization: {
          useMemories: "inherit",
          contributeMemories: "inherit"
        }
      }
    });
    assert.equal(chatFailure.status, "rolled_back");
    assert.equal(state.themePreference(), "system", "chat failure must compensate preferences");
    agents.commitSettingsChat = originalCommitChat;

    const recoveryBase = await settings.snapshot(project.id);
    agents.commitSettingsConfig = async () => { throw new Error("injected ambiguous config failure"); };
    const originalRollbackConfig = agents.rollbackSettingsConfig.bind(agents);
    agents.rollbackSettingsConfig = async () => "failed";
    const recovery = await settings.save(project.id, {
      expectedPreferenceRevision: recoveryBase.preferenceRevision,
      expectedConfigRevision: recoveryBase.configRevision,
      themePreference: "dark",
      memory: { ...recoveryBase.memory }
    });
    assert.equal(recovery.status, "recovery_required");
    if (recovery.status !== "recovery_required") throw new Error("expected recovery_required");
    // commit 在真正写配置前失败，偏好已完成可验证补偿；下一次访问可安全清掉 journal。
    assert.equal((await settings.snapshot(project.id)).pendingRecovery, undefined);
    agents.commitSettingsConfig = originalCommitConfig;
    agents.rollbackSettingsConfig = originalRollbackConfig;

    const journalPath = state.settingsTransactionJournalPath();
    await rm(journalPath, { force: true });
    const startupBase = await settings.snapshot(project.id);
    const startupBefore = state.settingsPreferences();
    const startupAfter = await state.applySettingsPreferences({ themePreference: "dark" }, startupBefore.revision);
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      id: "startup-recovery-journal",
      projectId: project.id,
      createdAt: new Date().toISOString(),
      segments: {
        preferences: { included: true, state: "committed", before: startupBefore, after: startupAfter },
        config: {
          included: false,
          state: "pending",
          beforeRevision: startupBase.configRevision,
          targetRevision: startupBase.configRevision,
          credentialHandles: []
        },
        chatMetadata: { included: false, state: "pending" }
      }
    }, null, 2)}\n`);
    const restartedState = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
    await restartedState.load();
    const restartedAgents = new DesktopAgentManager(restartedState, projects, configStore, () => undefined);
    const restarted = new DesktopSettingsTransaction(restartedState, restartedAgents);
    const recovered = await restarted.snapshot(project.id);
    assert.equal(recovered.pendingRecovery, undefined);
    assert.equal(recovered.themePreference, "dark", "startup recovery finalizes a fully committed preference-only transaction");
    await restartedAgents.closeAll();
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopToolModelSelection(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-model-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-model-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    // 加一个可切换的第二模型。
    const base = await configStore.load(workspaceRoot);
    await configStore.save({
      ...base,
      models: {
        ...base.models,
        "alt-model": { provider: "active", model: "alt-model", contextWindow: 128_000 }
      }
    }, workspaceRoot);

    const settings = new DesktopSettingsTransaction(state, agents);
    // models 事务切换默认模型：与聊天里 switchModel 的落盘语义一致（defaultModel + thinking）。
    const switched = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], defaultModel: { alias: "alt-model", thinking: "high" } }
    });
    assert.equal(switched.models.defaultModel, "alt-model");
    const persisted = await configStore.load(workspaceRoot);
    assert.equal(persisted.defaultModel, "alt-model");
    assert.equal(persisted.thinking.enabled, true);
    assert.equal(persisted.thinking.effort, "high");

    const withToolModel = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], toolModel: { alias: "test-model" } }
    });
    assert.equal(withToolModel.models.toolModel, "test-model");
    assert.equal(withToolModel.models.resolvedToolModel, "test-model");
    assert.equal((await configStore.load(workspaceRoot)).toolModel, "test-model");
    assert.equal(withToolModel.models.defaultModel, "alt-model", "工具模型与聊天模型独立保存");
    const automatic = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], toolModel: {} }
    });
    assert.equal(automatic.models.toolModel, undefined, "空选择明确恢复自动模式");
    assert.ok(automatic.models.resolvedToolModel);
    await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], toolModel: { alias: "test-model" } }
    });
    const removed = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: ["test-model"] }
    });
    assert.equal(removed.models.toolModel, undefined, "删除工具模型时移除悬空引用");
    assert.equal(removed.models.resolvedToolModel, "alt-model");
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopGlobalWriteGateAndRuntimeRefresh(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-gate-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-gate-second-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-gate-data-"));
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  try {
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.setPermissionMode(first.id, "read-only");
    await agents.setPermissionMode(second.id, "read-only");

    const internals = agents as unknown as {
      rebuildManagedRuntime(projectId: string, managed: unknown): Promise<void>;
    };
    const originalRebuild = internals.rebuildManagedRuntime.bind(agents);
    const rebuilt: string[] = [];
    internals.rebuildManagedRuntime = async (projectId: string, _managed: unknown): Promise<void> => {
      rebuilt.push(projectId);
    };

    const before = await agents.settingsConfigSnapshot(first.id);
    const prepared = await agents.prepareSettingsConfig(first.id, {
      expectedPreferenceRevision: state.settingsPreferences().revision,
      expectedConfigRevision: before.revision,
      // 翻转一个布尔让 config 内容真正变化：revision 是内容哈希，settingsCommitted 仅在
      // before/target revision 不同时才触发派生 Runtime 重建。
      memory: { ...before.memory, useMemories: !before.memory.useMemories }
    });
    const transactionId = "global-runtime-refresh";
    await agents.commitSettingsConfig(prepared, transactionId);
    assert.deepEqual(rebuilt, [], "配置提交本身不应等待派生 Runtime 刷新");
    agents.settingsCommitted(prepared);
    await (agents as unknown as { idleRuntimeRebuildTail: Promise<void> }).idleRuntimeRebuildTail;
    assert.deepEqual(new Set(rebuilt), new Set([first.id, second.id]), "提交确认后应刷新每个 resident idle Runtime");

    rebuilt.length = 0;
    assert.equal(await agents.rollbackSettingsConfig(prepared, transactionId), "completed");
    assert.deepEqual(new Set(rebuilt), new Set([first.id, second.id]), "config rollback must refresh the same resident runtimes");
    internals.rebuildManagedRuntime = originalRebuild;

    // 模拟第二个项目正在运行：当前项目本身空闲也必须拒绝所有共享写入口。
    const originalHasRunningTasks = agents.hasRunningTasks.bind(agents);
    agents.hasRunningTasks = () => true;
    const current = await agents.settingsConfigSnapshot(first.id);
    assert.throws(() => agents?.assertNoRunningTasks(), /任务运行期间/u);
    await assert.rejects(
      agents.prepareSettingsConfig(first.id, {
        expectedPreferenceRevision: state.settingsPreferences().revision,
        expectedConfigRevision: current.revision,
        memory: { ...current.memory }
      }),
      /任务运行期间/u
    );
    await assert.rejects(
      agents.addMemoryEntry(first.id, {
        content: "另一个项目正在运行时，共享记忆库必须拒绝当前项目发起的新写入操作。",
        tags: ["gate"],
        importance: 3
      }, 0),
      /任务运行期间/u
    );
    await assert.rejects(
      agents.saveMemorySettings(first.id, {
        expectedRevision: current.revision,
        settings: { ...current.memory, enabled: true }
      }),
      /任务运行期间/u
    );
    const settings = new DesktopSettingsTransaction(state, agents);
    const preferenceSnapshot = await settings.snapshot(first.id);
    const preferenceResult = await settings.save(first.id, {
      expectedPreferenceRevision: preferenceSnapshot.preferenceRevision,
      expectedConfigRevision: preferenceSnapshot.configRevision,
      themePreference: "dark"
    });
    assert.equal(preferenceResult.status, "committed", JSON.stringify(preferenceResult));
    assert.deepEqual(preferenceResult.appliedFields, ["themePreference"]);
    assert.equal(state.themePreference(), "dark", "主题偏好不应被运行中的任务阻止保存");
    agents.hasRunningTasks = originalHasRunningTasks;
  } finally {
    await agents?.closeAll();
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSettingsSaveReturnsBeforeRuntimeRefresh(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-save-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-save-second-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-save-data-"));
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  let releaseRebuild: () => void = () => undefined;
  try {
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.setPermissionMode(first.id, "read-only");
    await agents.setPermissionMode(second.id, "read-only");

    const internals = agents as unknown as {
      rebuildManagedRuntime(projectId: string, managed: unknown): Promise<void>;
      idleRuntimeRebuildTail: Promise<void>;
    };
    const rebuilt: string[] = [];
    let resolveRebuildStarted: () => void = () => undefined;
    const rebuildStarted = new Promise<void>((resolve) => { resolveRebuildStarted = resolve; });
    const rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    internals.rebuildManagedRuntime = async (projectId: string, _managed: unknown): Promise<void> => {
      rebuilt.push(projectId);
      resolveRebuildStarted();
      await rebuildGate;
    };

    const settings = new DesktopSettingsTransaction(state, agents);
    const initial = await settings.snapshot(first.id);
    const result = await settings.save(first.id, {
      expectedPreferenceRevision: initial.preferenceRevision,
      expectedConfigRevision: initial.configRevision,
      // 翻转一个布尔让 config 内容真正变化：只有 before/target revision 不同，
      // settingsCommitted 才会触发后台 Runtime 重建（本测试正是要观察那次重建）。
      memory: {
        ...initial.memory,
        useMemories: !initial.memory.useMemories
      }
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.deepEqual(rebuilt, [], "设置事务返回 committed 时不应等待 Runtime 重建");

    await Promise.race([
      rebuildStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    ]);
    assert.deepEqual(rebuilt, [first.id], "保存返回后才开始后台刷新当前 resident Runtime");
    releaseRebuild();
    await internals.idleRuntimeRebuildTail;
    assert.deepEqual(new Set(rebuilt), new Set([first.id, second.id]));
  } finally {
    releaseRebuild();
    await agents?.closeAll();
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopGlobalPersonalizationRefreshesInBackground(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-personalization-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-personalization-second-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-personalization-data-"));
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  let releaseRebuild: () => void = () => undefined;
  try {
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.setPermissionMode(first.id, "read-only");
    await agents.setPermissionMode(second.id, "read-only");

    const internals = agents as unknown as {
      rebuildManagedRuntime(projectId: string, managed: unknown): Promise<void>;
      idleRuntimeRebuildTail: Promise<void>;
    };
    const rebuilt: string[] = [];
    let resolveRebuildStarted: () => void = () => undefined;
    const rebuildStarted = new Promise<void>((resolve) => { resolveRebuildStarted = resolve; });
    const rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    internals.rebuildManagedRuntime = async (projectId: string, _managed: unknown): Promise<void> => {
      rebuilt.push(projectId);
      resolveRebuildStarted();
      await rebuildGate;
    };

    const initial = await agents.personalizationOverview(first.id);
    const saved = await agents.saveMemorySettings(first.id, {
      expectedRevision: initial.configRevision,
      settings: { ...initial.memory, useMemories: !initial.memory.useMemories }
    });
    assert.equal(saved.settings.useMemories, !initial.memory.useMemories);
    assert.deepEqual(rebuilt, [], "全局记忆设置返回前不应等待空闲 Runtime 重建");

    await Promise.race([
      rebuildStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    ]);
    assert.deepEqual(rebuilt, [first.id], "设置返回后才开始后台重建当前空闲 Runtime");
    releaseRebuild();
    await internals.idleRuntimeRebuildTail;
    assert.deepEqual(new Set(rebuilt), new Set([first.id, second.id]));
  } finally {
    releaseRebuild();
    await agents?.closeAll();
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSettingsCredentialLifecycle(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-credential-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-settings-credential-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const released = agents.stageSettingsCredential("released-secret", { projectId: project.id, purpose: "model", providerAlias: "released" });
    agents.releaseSettingsCredentials([released.handle]);
    const current = await agents.settingsConfigSnapshot(project.id);
    await assert.rejects(
      agents.prepareSettingsConfig(project.id, {
        expectedPreferenceRevision: 0,
        expectedConfigRevision: current.revision,
        models: {
          upserts: [{
            alias: "released-model",
            displayName: "Released model",
            providerAlias: "released",
            providerType: "openai-compatible",
            model: "released-model",
            apiKeyHandle: released.handle,
            supportsTools: true
          }],
          removeAliases: []
        }
      }),
      /不存在或已过期/u
    );

    const mismatched = agents.stageSettingsCredential("mismatched-secret", { projectId: project.id, purpose: "model", providerAlias: "scoped" });
    await assert.rejects(
      agents.prepareSettingsConfig(project.id, {
        expectedPreferenceRevision: 0,
        expectedConfigRevision: current.revision,
        models: {
          upserts: [{
            alias: "mismatched-model",
            displayName: "Mismatched model",
            providerAlias: "different",
            providerType: "openai-compatible",
            model: "mismatched-model",
            apiKeyHandle: mismatched.handle,
            supportsTools: true
          }],
          removeAliases: []
        }
      }),
      /句柄与当前项目、用途或服务商不匹配/u
    );
    agents.releaseSettingsCredentials([mismatched.handle]);

    const expired = agents.stageSettingsCredential("expired-secret", { projectId: project.id, purpose: "model", providerAlias: "expired" });
    const stagedCredentials = (agents as unknown as {
      stagedSettingsCredentials: Map<string, { expiresAt: number }>;
    }).stagedSettingsCredentials;
    stagedCredentials.get(expired.handle)!.expiresAt = Date.now() - 1;
    await assert.rejects(
      agents.prepareSettingsConfig(project.id, {
        expectedPreferenceRevision: 0,
        expectedConfigRevision: current.revision,
        models: {
          upserts: [{
            alias: "expired-model",
            displayName: "Expired model",
            providerAlias: "expired",
            providerType: "openai-compatible",
            model: "expired-model",
            apiKeyHandle: expired.handle,
            supportsTools: true
          }],
          removeAliases: []
        }
      }),
      /不存在或已过期/u
    );

    const staged = agents.stageSettingsCredential("one-shot-secret", { projectId: project.id, purpose: "model", providerAlias: "staged" });
    const transaction = new DesktopSettingsTransaction(state, agents);
    const snapshot = await transaction.snapshot(project.id);
    const saved = await transaction.save(project.id, {
      expectedPreferenceRevision: snapshot.preferenceRevision,
      expectedConfigRevision: snapshot.configRevision,
      models: {
        upserts: [{
          alias: "staged-model",
          displayName: "Staged model",
          providerAlias: "staged",
          providerType: "openai-compatible",
          model: "staged-model",
          baseUrl: "https://example.com/v1",
          contextWindow: 128_000,
          apiKeyHandle: staged.handle,
          supportsTools: true
        }],
        removeAliases: []
      }
    });
    assert.equal(saved.status, "committed", JSON.stringify(saved));
    const after = await agents.settingsConfigSnapshot(project.id);
    await assert.rejects(
      agents.prepareSettingsConfig(project.id, {
        expectedPreferenceRevision: state.settingsPreferences().revision,
        expectedConfigRevision: after.revision,
        models: {
          upserts: [{
            alias: "staged-model-copy",
            displayName: "Staged model copy",
            providerAlias: "staged-copy",
            providerType: "openai-compatible",
            model: "staged-model-copy",
            apiKeyHandle: staged.handle,
            supportsTools: true
          }],
          removeAliases: []
        }
      }),
      /不存在或已过期/u
    );
    const configText = await readFile(path.join(desktopRoot, "config.json"), "utf8");
    assert.equal(configText.includes("one-shot-secret"), false, "staged credential must not enter config document");
    assert.equal((await readFile(state.settingsTransactionJournalPath(), "utf8").catch(() => "")).includes("one-shot-secret"), false);
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopModelConfiguration(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-config-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const initialConfig = structuredClone(defaultConfig);
    initialConfig.models["deepseek-deepseek-v4-flash"] = { ...initialConfig.models["deepseek-v4-flash"] };
    initialConfig.providers.deepseek!.apiKey = "test-key";
    initialConfig.providers.deepseek!.headers = { "X-Provider-Route": "stable" };
    initialConfig.providers.deepseek!.modelsEndpoint = "https://api.deepseek.com/models";
    initialConfig.models["deepseek-v4-flash"]!.headers = { "X-Model-Route": "flash" };
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    await configStore.save(initialConfig);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const settings = new DesktopSettingsTransaction(state, agents);
    // Enabling an extra model must not hijack the active default — that is what
    // the settings "启用模型" toggles do on every click.
    const enabledOnly = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [{
          alias: "local-qwen-extra",
          displayName: "本地 Qwen 备用",
          providerAlias: "local",
          providerType: "ollama",
          model: "qwen3:4b",
          baseUrl: "http://127.0.0.1:11434/v1",
          contextWindow: 128_000,
          apiKeyEnv: undefined,
          apiKey: undefined,
          supportsTools: true,
          supportsThinking: false
        }],
        removeAliases: []
      }
    });
    assert.equal((await configStore.load()).defaultModel, "deepseek-v4-flash");
    assert.equal(enabledOnly.models.configured.some((model) => model.alias === "local-qwen-extra"), true);

    const snapshot = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [{
          alias: "local-qwen",
          displayName: "本地 Qwen",
          providerAlias: "local",
          providerType: "ollama",
          model: "qwen3:8b",
          baseUrl: "http://127.0.0.1:11434/v1",
          contextWindow: 128_000,
          apiKeyEnv: undefined,
          apiKey: undefined,
          supportsTools: true,
          supportsThinking: false,
          makeDefault: true
        }],
        removeAliases: []
      }
    });
    const config = await configStore.load();
    assert.equal(config.defaultModel, "local-qwen");
    assert.equal(config.providers.local?.type, "ollama");
    assert.equal(config.models["local-qwen"]?.model, "qwen3:8b");
    assert.equal(snapshot.models.configured.some((model) => model.alias === "local-qwen"), true);
    const modelManager = new ModelManager(desktopRoot, config, configStore);
    const externallyUpdatedConfig = structuredClone(config);
    externallyUpdatedConfig.defaultModel = "local-qwen-next";
    externallyUpdatedConfig.models["local-qwen-next"] = { ...externallyUpdatedConfig.models["local-qwen"], model: "qwen3:14b", displayName: "本地 Qwen Next" };
    await configStore.save(externallyUpdatedConfig);
    const refreshedInfo = await modelManager.refreshFromDisk();
    assert.equal(refreshedInfo.modelAlias, "local-qwen-next");
    await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [{
          alias: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          providerAlias: "deepseek",
          providerType: "deepseek",
          model: "deepseek-v4-flash",
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: undefined,
          apiKey: undefined,
          supportsTools: true,
          supportsThinking: true
        }],
        removeAliases: []
      }
    });
    const cleanedConfig = await configStore.load();
    assert.equal(cleanedConfig.models["deepseek-deepseek-v4-flash"], undefined);
    assert.equal(cleanedConfig.models["deepseek-v4-flash"]?.contextWindow, undefined);
    assert.deepEqual(cleanedConfig.providers.deepseek?.headers, { "X-Provider-Route": "stable" });
    assert.equal(cleanedConfig.providers.deepseek?.modelsEndpoint, "https://api.deepseek.com/models");
    assert.deepEqual(cleanedConfig.models["deepseek-v4-flash"]?.headers, { "X-Model-Route": "flash" });
    await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [{
          alias: "plan-flash",
          displayName: "Plan Flash",
          providerAlias: "plan",
          providerType: "openai-compatible",
          model: "deepseek-v4-flash",
          baseUrl: "https://plan.example/v1",
          contextWindow: 128_000,
          maxInputTokens: 120_000,
          apiKey: "plan-test-key",
          supportsTools: true,
          supportsThinking: true,
          modelProfile: {
            contextWindow: 512_000,
            maxInputTokens: 480_000,
            maxOutputTokens: 96_000,
            thinkingLevelMap: { off: "none", high: "gateway-high" }
          }
        }],
        removeAliases: []
      }
    });
    const planConfig = await configStore.load();
    assert.equal(planConfig.models["plan-flash"]?.contextWindow, undefined, "catalog metadata is not copied into a new alias");
    assert.equal(planConfig.models["plan-flash"]?.maxInputTokens, undefined, "catalog input limits are not copied into a new alias");
    assert.equal(planConfig.models["plan-flash"]?.thinkingLevelMap, undefined, "catalog thinking metadata is not copied into a new alias");
    assert.deepEqual(planConfig.providers.plan?.modelProfiles, {
      "deepseek-v4-flash": {
        contextWindow: 512_000,
        maxInputTokens: 480_000,
        maxOutputTokens: 96_000,
        thinkingLevelMap: { off: "none", high: "gateway-high" }
      }
    });
    // 停用和重新启用只改变显示偏好，模型配置、凭据与自定义元数据必须原样保留。
    for (const showInPicker of [false, true]) {
      const visibilitySnapshot = await commitDesktopSettings(settings, project.id, {
        models: {
          upserts: [],
          removeAliases: [],
          modelProfiles: {
            plan: {
              ...planConfig.providers.plan?.modelProfiles,
              "deepseek-v4-flash": {
                ...planConfig.providers.plan?.modelProfiles?.["deepseek-v4-flash"],
                showInPicker
              }
            }
          }
        }
      });
      const persisted = await configStore.load();
      assert.deepEqual(persisted.models, planConfig.models);
      assert.equal(persisted.providers.plan?.apiKey, planConfig.providers.plan?.apiKey);
      assert.equal(persisted.providers.plan?.modelProfiles?.["deepseek-v4-flash"]?.contextWindow, 512_000);
      assert.equal(persisted.providers.plan?.modelProfiles?.["deepseek-v4-flash"]?.showInPicker, showInPicker);
      assert.equal(visibilitySnapshot.models.configured.find((model) => model.alias === "plan-flash")?.showInPicker, showInPicker);
    }
    for (const format of ["responses", "auto"] as const) {
      const formatSnapshot = await commitDesktopSettings(settings, project.id, {
        models: { upserts: [], removeAliases: [], providerApiFormats: { plan: format } }
      });
      const formatConfig = await configStore.load();
      assert.equal(formatConfig.providers.plan?.apiBackend, format === "auto" ? undefined : format);
      assert.equal(formatSnapshot.models.connections.find((item) => item.providerAlias === "plan")?.apiBackend, format === "auto" ? undefined : format);
      assert.deepEqual(formatConfig.models, planConfig.models, "连接格式切换保留单个模型的配置");
    }
    const withoutModel = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: ["plan-flash"] }
    });
    const removedModelConfig = await configStore.load();
    assert.equal(removedModelConfig.models["plan-flash"], undefined);
    assert.equal(removedModelConfig.providers.plan?.modelProfiles?.["deepseek-v4-flash"], undefined);
    assert.ok(withoutModel.models.connections.some((connection) => connection.providerAlias === "plan"));
    const emptyConnection = connectionLabel(withoutModel.models.configured, withoutModel.models.connections).find((group) => group.provider === "plan");
    assert.ok(emptyConnection, "删除最后一个模型后，连接仍在设置列表中");
    assert.equal(emptyConnection.models.length, 0);
    const withoutProvider = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], removeProviderAliases: ["plan"] }
    });
    assert.equal((await configStore.load()).providers.plan, undefined);
    assert.equal(withoutProvider.models.connections.some((connection) => connection.providerAlias === "plan"), false);
    await projects.listSessions(project, undefined, new Map());
    const attachment = await projects.saveAttachment(project, "notes.txt", "text/plain", new TextEncoder().encode("desktop only"));
    assert.match(attachment.path, /^@attachments\//);
    // Project sessions and attachments are global but remain project-scoped.
    await access(path.dirname(sessionFilePath(workspaceRoot, "path-probe")));
    await assert.rejects(access(path.join(workspaceRoot, ".biny", "sessions")));
    await access(path.join(agentDir(workspaceRoot), "attachments"));
    await assert.rejects(access(path.join(workspaceRoot, ".biny", "attachments")));
    await assert.rejects(access(path.join(desktopRoot, "projects", project.id, ".biny", "attachments")));
    await assert.rejects(access(path.join(workspaceRoot, "config.json")));
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** 自定义服务商「先建连接、后补模型」：providers 段独立写入，模型 upsert 不丢显示名与端点。 */
async function testDesktopCustomProviderConnection(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-custom-provider-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const settings = new DesktopSettingsTransaction(state, agents);
    const beforeConfig = await configStore.load();

    // 创建不含任何模型的服务商连接：providers 段新增条目，models 与默认模型不动。
    const created = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [],
        removeAliases: [],
        customProviders: [{
          alias: "my-relay",
          displayName: "我的中转",
          baseUrl: "https://relay.example/v1",
          protocol: "openai-compatible",
          apiBackend: "chat_completions",
          apiKey: "relay-key"
        }]
      }
    });
    const createdConfig = await configStore.load();
    const relayProvider = createdConfig.providers["my-relay"];
    assert.equal(relayProvider?.type, "openai-compatible");
    assert.equal(relayProvider?.displayName, "我的中转");
    assert.equal(relayProvider?.baseUrl, "https://relay.example/v1");
    assert.equal(relayProvider?.apiKey, "relay-key");
    assert.equal(relayProvider?.requiresApiKey, true);
    assert.equal(relayProvider?.apiBackend, "chat_completions");
    assert.deepEqual(createdConfig.models, beforeConfig.models, "创建服务商不新增模型");
    assert.equal(createdConfig.defaultModel, beforeConfig.defaultModel);
    const connection = created.models.connections.find((item) => item.providerAlias === "my-relay");
    assert.equal(connection?.displayName, "我的中转");
    assert.equal(connection?.hasCredential, true);
    assert.equal(connection?.baseUrl, "https://relay.example/v1");

    // 在零模型连接上启用模型：模型落在同一 provider 下，显示名/端点/密钥原样保留。
    const enabled = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [{
          alias: "my-relay-test-model",
          displayName: "test-model",
          providerAlias: "my-relay",
          providerType: "openai-compatible",
          protocol: "openai-compatible",
          model: "test-model",
          apiKeyEnv: undefined,
          requiresApiKey: true,
          supportsTools: true,
          supportsThinking: false
        }],
        removeAliases: []
      }
    });
    const enabledConfig = await configStore.load();
    assert.equal(enabledConfig.models["my-relay-test-model"]?.model, "test-model");
    assert.equal(enabledConfig.providers["my-relay"]?.displayName, "我的中转", "模型 upsert 保留 provider 显示名");
    assert.equal(enabledConfig.providers["my-relay"]?.baseUrl, "https://relay.example/v1");
    assert.equal(enabledConfig.providers["my-relay"]?.apiKey, "relay-key");
    assert.equal(enabled.models.configured.some((model) => model.alias === "my-relay-test-model"), true);

    // 端点补丁按合并语义改写（与模型级「服务地址」提交一致），显示名等未提供字段保留。
    const rewired = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [],
        removeAliases: [],
        customProviders: [{ alias: "my-relay", baseUrl: "https://other.example/v1" }]
      }
    });
    const rewiredConfig = await configStore.load();
    assert.equal(rewiredConfig.providers["my-relay"]?.baseUrl, "https://other.example/v1");
    assert.equal(rewiredConfig.providers["my-relay"]?.displayName, "我的中转");
    assert.equal(rewired.models.connections.find((item) => item.providerAlias === "my-relay")?.baseUrl, "https://other.example/v1");

    // 零模型连接创建后仍可修补（如修正地址），字段按合并语义落盘。
    await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [],
        removeAliases: [],
        customProviders: [{ alias: "empty-relay", displayName: "Empty", baseUrl: "https://empty.example/v1" }]
      }
    });
    const patched = await commitDesktopSettings(settings, project.id, {
      models: {
        upserts: [],
        removeAliases: [],
        customProviders: [{ alias: "empty-relay", baseUrl: "https://empty.example/v2" }]
      }
    });
    const patchedConfig = await configStore.load();
    assert.equal(patchedConfig.providers["empty-relay"]?.baseUrl, "https://empty.example/v2");
    assert.equal(patchedConfig.providers["empty-relay"]?.displayName, "Empty");
    assert.equal(patched.models.connections.some((item) => item.providerAlias === "empty-relay" && item.baseUrl === "https://empty.example/v2"), true);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopModelSwitchDoesNotResumeInterruptedTurn(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-switch-resume-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-switch-resume-data-"));
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    // 让跨进程尝试立即失败，进入同进程 fallback；这样使用测试注入的 configStore，
    // 同时仍覆盖 Desktop 的完整初始化分支，不留下 detached Host。
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const interruptedSessionId = "interrupted-before-model-switch";
    const recorder = new SessionRecorder(dataRoot, interruptedSessionId);
    recorder.record({ type: "user_message", content: "继续处理之前的任务" });
    recorder.record({
      type: "turn_status",
      status: "incomplete",
      stopReason: "hard_step_limit",
      steps: 1_000_000,
      summary: "测试用中断回合",
      resumable: true
    });
    await recorder.close();

    const interruptedMessages: AgentMessage[] = [{ role: "user", content: "继续处理之前的任务" }];
    await new TurnStore(dataRoot, interruptedSessionId).save(
      "继续处理之前的任务",
      undefined,
      interruptedMessages,
      1_000_000
    );

    // 不选中这个会话：普通 Desktop 初始化只能创建空闲 runtime，不能把磁盘上的
    // resumable turn 当成启动命令。只有用户点击「继续运行」才允许调用恢复入口。
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const switched = await agents.switchModel(project.id, "test-model", "off");
    assert.equal(switched.modelAlias, "test-model");
    const snapshot = await agents.workspaceSnapshot(project.id);
    assert.notEqual(snapshot.runtime?.info.sessionId, interruptedSessionId);
    assert.equal(snapshot.runtime?.state.kind, "idle");
  } finally {
    await agents?.closeAll();
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopModelSwitchDoesNotStartDetachedHost(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-switch-control-plane-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-switch-control-plane-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const storage = new DesktopUserDataStore(desktopRoot);
    await storage.initialize();
    const state = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
    await state.load();
    const configStore = new DesktopConfigStore(desktopRoot, memoryCredentialStore());
    await configStore.save({
      ...defaultConfig,
      defaultModel: "test-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
      models: { "test-model": { provider: "active", model: "test-model", contextWindow: 128_000 } },
      thinking: { ...defaultConfig.thinking, enabled: false }
    });
    const projects = new DesktopProjectService(state, storage, configStore);
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);

    // 全局活动设置不依赖项目；这个读取路径不能再借用 settingsSnapshot("")。
    const activity = new ActivityRecorderService({ configStore, sidecarPath: undefined });
    const activityConfig = await configStore.loadVersioned();
    assert.deepEqual(await activity.settingsSnapshot(), { activity: activityConfig.config.activity, configRevision: activityConfig.revision });

    const switched = await agents.switchModel(project.id, "test-model", "off");
    assert.equal(switched.modelAlias, "test-model");
    const snapshot = await agents.workspaceSnapshot(project.id);
    assert.equal(snapshot.runtime, undefined, "control-plane model selection must not start a detached host");
    assert.equal(snapshot.runtimeError, undefined);
    assert.equal(configStore.supportsDetachedRuntimeHost, false);
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSubagentSlashCommands(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-subagent-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-subagent-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await mkdir(path.join(workspaceRoot, ".biny", "agents"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".biny", "agents", "planner.md"),
      "---\nname: planner\ndescription: 拆解任务并给出执行计划\n---\n先读代码再给结论。\n"
    );
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);

    // 桌面端 /subagent 与 TUI 同构：agents / status / cancel / 用法提示都不该再抛「仅支持 agents」。
    const list = await agents.runSlashCommand(project.id, undefined, "/subagent agents");
    assert.match(list.content, /planner/);

    const status = await agents.runSlashCommand(project.id, undefined, "/subagent status");
    assert.match(status.content, /No subagent tasks/);

    const cancelMissing = await agents.runSlashCommand(project.id, undefined, "/subagent cancel task-404");
    assert.match(cancelMissing.content, /No active subagent task found for task-404/);

    await assert.rejects(agents.runSlashCommand(project.id, undefined, "/subagent cancel"), /task-id/);
    await assert.rejects(agents.runSlashCommand(project.id, undefined, "/subagent start"), /start/);

    const usage = await agents.runSlashCommand(project.id, undefined, "/subagent");
    assert.match(usage.content, /status \| cancel <task-id> \| agents/);

    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopDoesNotResumePersistedIdleSession(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-runtime-lease-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-runtime-lease-data-"));
  let owner: SessionLeaseStore | undefined;
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    owner = await SessionLeaseStore.open(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "session-owner");
    recorder.record({ type: "user_message", content: "owner session" });
    await recorder.close();
    await state.setSelectedSession(project.id, "session-owner");
    owner.acquire("session-owner");
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const snapshot = await agents.setPermissionMode(project.id, "read-only");
    assert.notEqual(snapshot.runtime?.info.sessionId, "session-owner");
    assert.equal(snapshot.runtimeError, undefined);
    assert.equal(snapshot.runtime?.permissionMode, "read-only");
    // Desktop 启动时只看到一个新的空闲 runtime；只有用户显式打开并发送到历史
    // session 时，才会走 resumeSession 并报告旧 session 的 lease 冲突。
    const workspace = await agents.workspaceSnapshot(project.id);
    assert.equal(workspace.selectedSessionId, "session-owner");
  } finally {
    await agents?.closeAll();
    owner?.close();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopPermissionModePersistsInIdleSnapshot(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-mode-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-mode-data-"));
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    // 让测试稳定覆盖同进程 owner；重点验证的是配置持久化后的 Desktop 首屏投影。
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);

    const selected = await agents.setPermissionMode(project.id, "auto");
    assert.equal(selected.runtime?.permissionMode, "auto");
    await agents.closeAll();

    // 新一轮 Desktop 尚未创建 runtime 时，也必须从共享配置展示上次选择，而不是回退到 ask。
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const restored = await agents.workspaceSnapshot(project.id);
    assert.equal(restored.runtime, undefined);
    assert.equal(restored.permissionMode, "auto");
    assert.equal((await configStore.load()).permission.mode, "auto");
  } finally {
    await agents?.closeAll();
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopPermissionModePersistsThroughExistingHost(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-existing-host-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-existing-host-data-"));
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  let host: { closeOwner(): Promise<void> } | undefined;
  try {
    process.env.BINY_AGENT_DIR = desktopRoot;
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const localHost = await createInteractiveAgentHost(project.path, {
      persistenceRoot: dataRoot,
      configStore,
      attachmentRoot: projects.attachmentsRoot(project)
    });
    host = await startRuntimeHost(dataRoot, async () => ({ runtime: localHost.runtime, commands: localHost.commands }), { configDir: desktopRoot });

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.setPermissionMode(project.id, "full-access");
    assert.equal(localHost.runtime.getSnapshot().permissionMode, "full-access");
    assert.equal((await configStore.load(project.path)).permission.mode, "full-access");

    await agents.closeAll();
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const restored = await agents.workspaceSnapshot(project.id);
    assert.equal(restored.permissionMode, "full-access");
  } finally {
    await agents?.closeAll();
    await host?.closeOwner();
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopReconcilesPersistedPermissionWithExistingHost(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-host-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-permission-host-data-"));
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  let host: { closeOwner(): Promise<void> } | undefined;
  try {
    // DesktopAgentManager 生产环境通过 globalConfigDir() 发现 Host；测试把两端显式
    // 放到同一临时配置根，模拟“调试客户端重开时 attach 到旧 Host”的真实路径。
    process.env.BINY_AGENT_DIR = desktopRoot;
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const commands = fakeCommandRuntime();
    let hostPermissionMode: "ask" | "read-only" | "auto" | "full-access" = "ask";
    commands.agent.getPermissionMode = () => hostPermissionMode;
    commands.agent.setPermissionMode = async (mode) => {
      hostPermissionMode = mode;
    };
    const runtime = new InteractiveAgentRuntime(commands);
    host = await startRuntimeHost(dataRoot, async () => ({ runtime: runtime, commands: commands }), { configDir: desktopRoot });

    const persisted = await configStore.load(project.path);
    persisted.permission.mode = "full-access";
    await configStore.save(persisted, project.path);

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    // 任意需要 Runtime 的入口都会 attach 到上面的旧 Host；切模型本身不应改变权限，
    // 只用来触发“客户端进入后接管已有 Runtime”的启动链路。
    await agents.switchModel(project.id, "test-model", "off");
    assert.equal(hostPermissionMode, "full-access");
    assert.equal(runtime.getSnapshot().permissionMode, "full-access");
    assert.equal((await configStore.load(project.path)).permission.mode, "full-access");
  } finally {
    await agents?.closeAll();
    await host?.closeOwner();
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopMemoryChangesKeepPermissionMode(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-memory-permission-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-memory-permission-data-"));
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  let localHost: Awaited<ReturnType<typeof createInteractiveAgentHost>> | undefined;
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  try {
    process.env.BINY_AGENT_DIR = desktopRoot;
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const createRuntime = async (sessionId?: string, factoryOptions?: RuntimeHostFactoryOptions) => {
      const fresh = factoryOptions?.fresh === true;
      const next = await createInteractiveAgentHost(factoryOptions?.workspaceRoot ?? project.path, {
        persistenceRoot: dataRoot,
        configStore,
        attachmentRoot: projects.attachmentsRoot(project),
        sessionId: fresh ? sessionId : undefined
      });
      try {
        if (sessionId !== undefined && !fresh) await next.runtime.resumeSession(sessionId);
        return next;
      } catch (error) {
        await next.runtime.close();
        throw error;
      }
    };
    localHost = await createRuntime();
    host = await startRuntimeHost(dataRoot, async () => ({ runtime: localHost.runtime, commands: localHost.commands }), {
      configDir: desktopRoot,
      createRuntime
    });

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const permission = await agents.setPermissionMode(project.id, "full-access");
    assert.equal(permission.permissionMode, "full-access");

    const initial = await agents.personalizationOverview(project.id);
    const memory = await agents.saveMemorySettings(project.id, {
      expectedRevision: initial.configRevision,
      settings: { ...initial.memory, useMemories: !initial.memory.useMemories }
    });
    assert.equal(memory.settings.useMemories, !initial.memory.useMemories);
    assert.equal(host.getCurrentRuntime().getSnapshot().permissionMode, "full-access");
    assert.equal((await configStore.load(project.path)).permission.mode, "full-access");
    assert.equal((await agents.workspaceSnapshot(project.id)).permissionMode, "full-access");

    const recorder = new SessionRecorder(dataRoot, "memory-permission-session");
    recorder.record({ type: "user_message", content: "切换当前聊天记忆" });
    await recorder.close();
    const document = await agents.openSession(project.id, recorder.sessionId);
    const chat = await agents.saveChatPersonalization(
      project.id,
      recorder.sessionId,
      {
        useMemories: initial.memory.useMemories,
        contributeMemories: initial.memory.useMemories
      },
      document.session.metadataRevision
    );
    assert.equal(chat.permissionMode, "full-access");
    assert.equal(chat.runtime?.permissionMode, "full-access");
    assert.equal((await configStore.load(project.path)).permission.mode, "full-access");
  } finally {
    await agents?.closeAll();
    await host?.closeOwner();
    if (localHost && !host) await localHost.runtime.close();
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopCredentialsAreSeparated(): Promise<void> {
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-credentials-"));
  try {
    const store = new DesktopConfigStore(desktopRoot, memoryCredentialStore());
    const config = structuredClone(defaultConfig);
    config.providers.deepseek!.apiKey = "desktop-secret";
    config.web.search.apiKey = "tvly-web-secret";
    await store.save(config);
    const settings = await readFile(path.join(desktopRoot, "config.json"), "utf8");
    assert.doesNotMatch(settings, /desktop-secret/);
    // 联网搜索密钥同样只进凭据后端，不落明文设置文件。
    assert.doesNotMatch(settings, /tvly-web-secret/);
    await assert.rejects(readFile(path.join(desktopRoot, "credentials.json"), "utf8"), /ENOENT/u);
    const loaded = await store.load();
    assert.equal(loaded.providers.deepseek?.apiKey, "desktop-secret");
    assert.equal(loaded.web.search.apiKey, "tvly-web-secret");
  } finally {
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopWebSearchSettings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-web-search-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-web-search-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const settings = new DesktopSettingsTransaction(state, agents);

    const initial = await settings.snapshot(project.id);
    assert.equal(initial.webSearch.enabled, false);
    assert.equal(initial.webSearch.provider, "anysearch");
    assert.equal(initial.webSearch.hasApiKey, false);

    const stagedKey = agents.stageSettingsCredential("tvly-test-secret", { projectId: project.id, purpose: "web-search", providerAlias: "tavily" });
    const saved = (await commitDesktopSettings(settings, project.id, {
      webSearch: {
        enabled: true,
        provider: "tavily",
        apiKey: undefined,
        apiKeyHandle: stagedKey.handle,
        apiKeyEnv: undefined,
        timeoutMs: 8_000,
        maxResults: 6
      }
    })).webSearch;
    assert.equal(saved.provider, "tavily");
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.envKeyName, "TAVILY_API_KEY");
    assert.equal(saved.maxResults, 6);

    // 同 provider 重新保存且未传 apiKey：已存密钥保留。
    const kept = (await commitDesktopSettings(settings, project.id, {
      webSearch: {
        enabled: true,
        provider: "tavily",
        apiKey: undefined,
        apiKeyEnv: undefined,
        timeoutMs: 8_000,
        maxResults: 6
      }
    })).webSearch;
    assert.equal(kept.hasApiKey, true);

    // 切换 provider 且未提供新密钥：旧密钥必须被清除，不能带给新服务商。
    const switched = (await commitDesktopSettings(settings, project.id, {
      webSearch: {
        enabled: true,
        provider: "brave",
        apiKey: undefined,
        apiKeyEnv: undefined,
        timeoutMs: 8_000,
        maxResults: 6
      }
    })).webSearch;
    assert.equal(switched.provider, "brave");
    assert.equal(switched.hasApiKey, false);
    assert.equal(switched.envKeyName, "BRAVE_SEARCH_API_KEY");
    assert.equal((await configStore.load()).web.search.apiKey, undefined);

    const google = (await commitDesktopSettings(settings, project.id, {
      webSearch: {
        enabled: true,
        provider: "google",
        apiKey: undefined,
        apiKeyEnv: undefined,
        timeoutMs: 8_000,
        maxResults: 6
      }
    })).webSearch;
    assert.equal(google.provider, "google");
    assert.equal(google.hasApiKey, false);
    assert.equal(google.envKeyName, undefined);

    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopPersonalizationCasAndChatOverride(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-personalization-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-personalization-data-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  try {
    process.env[BINY_AGENT_DIR_ENV] = desktopRoot;
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const recorder = new SessionRecorder(dataRoot, "personalization-session");
    recorder.record({ type: "user_message", content: "请为当前聊天使用独立的表达偏好" });
    await recorder.close();

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const initial = await agents.personalizationOverview(project.id);
    assert.match(initial.configRevision, /^sha256:/u);
    assert.equal(initial.chat, undefined);

    const saved = await agents.saveMemorySettings(project.id, {
      expectedRevision: initial.configRevision,
      settings: { ...initial.memory, useMemories: true, generateMemories: false }
    });
    assert.notEqual(saved.configRevision, initial.configRevision);
    assert.equal(saved.settings.useMemories, true);
    assert.equal(saved.settings.generateMemories, false);
    assert.equal(saved.settings.maxRecalled, initial.memory.maxRecalled);
    await assert.rejects(
      agents.saveMemorySettings(project.id, {
        expectedRevision: initial.configRevision,
        settings: { ...initial.memory, useMemories: false, generateMemories: false }
      }),
      /Global config revision conflict/u
    );

    const document = await agents.openSession(project.id, recorder.sessionId);
    const markedWorkspace = await agents.markSessionRead(project.id, recorder.sessionId, document.session.metadataRevision);
    const markedSummary = markedWorkspace.sessions.find((session) => session.id === recorder.sessionId);
    assert.ok(markedSummary?.metadataRevision);
    const override = {

      useMemories: false,
      contributeMemories: "inherit" as const
    };
    const workspace = await agents.saveChatPersonalization(
      project.id,
      recorder.sessionId,
      override,
      markedSummary.metadataRevision
    );
    const summary = workspace.sessions.find((session) => session.id === recorder.sessionId);
    assert.deepEqual(summary?.personalization, override);
    assert.notEqual(summary?.metadataRevision, markedSummary.metadataRevision);

    const current = await agents.personalizationOverview(project.id, recorder.sessionId);
    assert.deepEqual(current.chat?.override, override);
    assert.equal(current.chat?.effective.useMemories, false);
    assert.equal(current.chat?.effective.contributeMemories, false);
    await assert.rejects(
      agents.saveChatPersonalization(project.id, recorder.sessionId, override, markedSummary.metadataRevision),
      /Session catalog revision conflict/u
    );
  } finally {
    await agents?.closeAll();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopMemoryFlatStoreCas(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-scoped-memory-workspace-"));
  const otherWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-scoped-memory-other-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-scoped-memory-data-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  const previousHostEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  let agents: DesktopAgentManager | undefined;
  try {
    process.env[BINY_AGENT_DIR_ENV] = desktopRoot;
    process.env.BINY_RUNTIME_HOST_ENTRY = path.join(desktopRoot, "missing-runtime-host-entry.js");
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    const recorder = new SessionRecorder(dataRoot, "memory-source-session");
    recorder.record({ type: "user_message", content: "记住这条项目工作流" });
    await recorder.close();
    await state.setSelectedSession(project.id, recorder.sessionId);

    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const initialProject = await agents.memoryOverview(project.id);
    assert.equal(initialProject.revision, 0);
    assert.equal(initialProject.totalEntries, 0);
    assert.equal(initialProject.maintenance.state, "idle");
    const projectMemory = await agents.addMemoryEntry(project.id, {
      content: "发布前先运行 Desktop 类型检查和定向测试，并保留失败输出供排查。",
      tags: ["desktop", "typecheck"],
      rationale: "先验证再发布",
      importance: 5
    }, initialProject.revision);
    assert.equal(projectMemory.revision, 1);
    const projectEntries = await agents.memoryEntries(project.id, 0, 100);
    assert.equal(projectEntries.total, 1);
    assert.equal(projectEntries.entries[0]?.source, "manual");
    assert.equal(projectEntries.entries[0]?.importance, 5);
    assert.ok(projectEntries.entries[0]?.updatedAt);
    await assert.rejects(
      agents.addMemoryEntry(project.id, {
        content: "这条写入携带过期的 store revision，不能覆盖已经保存的项目记忆。",
        importance: 3
      }, initialProject.revision),
      /Memory revision conflict/u
    );

    // 扁平单库后没有 origin 门禁：普通事实不再需要特定语义或 audience 就能保存。
    const plainFact = await agents.addMemoryEntry(project.id, {
      content: "用户明确希望长任务的进度同步保持简洁，并优先说明已验证的结果。",
      tags: ["进度", "验证"],
      importance: 4
    }, projectMemory.revision);
    assert.equal(plainFact.revision, 2);
    assert.equal(plainFact.totalEntries, 2);
    assert.deepEqual(plainFact.memoryStats, { total: 2, autoGenerated: 0, manualAdded: 2 });
    assert.equal((await agents.memoryOverview(project.id)).revision, 2);

    // 另一个项目的写入落在同一个全局记忆库；两个项目读取到同一个 store revision。
    const otherProject = await projects.createProject(otherWorkspaceRoot);
    const otherMemory = await agents.addMemoryEntry(otherProject.id, {
      content: "这条事实来自另一个项目，保存在同一个全局记忆库中。",
      tags: ["other-project"],
      importance: 3
    }, plainFact.revision);
    assert.equal(otherMemory.revision, 3);
    const stats = await agents.memoryStats(project.id);
    assert.equal(stats.totalEntries, 3);
    assert.deepEqual(stats.memoryStats, { total: 3, autoGenerated: 0, manualAdded: 3 });
    const otherProjectStats = await agents.memoryStats(otherProject.id);
    assert.equal(otherProjectStats.revision, 3);

    const matches = await agents.searchMemory(project.id, "Desktop 类型检查");
    assert.equal(matches[0]?.id, projectEntries.entries[0]?.id);
    assert.match(matches[0]?.excerpt ?? "", /Desktop 类型检查/u);

    const updated = await agents.updateMemoryEntry(project.id, projectEntries.entries[0]!.id, {
      content: "发布前必须运行 Desktop 类型检查和定向测试，失败输出应原样保留供后续排查。",
      importance: 4
    }, otherMemory.revision);
    assert.equal(updated.revision, 4);
    const updatedEntries = await agents.memoryEntries(project.id, 0, 100);
    assert.match(
      updatedEntries.entries.find(({ id }) => id === projectEntries.entries[0]!.id)?.content ?? "",
      /原样保留/u
    );

    const policy = await agents.saveMemorySettings(project.id, {
      expectedRevision: updated.configRevision,
      settings: { ...updated.settings, enabled: true, useMemories: true, generateMemories: true, excludeExternalContext: false }
    });
    assert.equal(policy.settings.excludeExternalContext, false);
    assert.notEqual(policy.configRevision, updated.configRevision);
    await assert.rejects(
      agents.saveMemorySettings(project.id, {
        expectedRevision: updated.configRevision,
        settings: { ...policy.settings, excludeExternalContext: true }
      }),
      /Global config revision conflict/u
    );

    const afterDelete = await agents.deleteMemoryEntry(
      project.id,
      projectEntries.entries[0]!.id,
      updated.revision
    );
    assert.equal(afterDelete.revision, 5);
    assert.equal(afterDelete.totalEntries, 2);
    const afterDeleteEntries = await agents.memoryEntries(project.id, 0, 100);
    assert.equal(afterDeleteEntries.entries.some(({ id }) => id === projectEntries.entries[0]!.id), false);
    const cleared = await agents.clearMemory(project.id, afterDelete.revision);
    assert.equal(cleared.totalEntries, 0);
    assert.equal(cleared.revision, 6);
  } finally {
    await agents?.closeAll();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    if (previousHostEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY;
    else process.env.BINY_RUNTIME_HOST_ENTRY = previousHostEntry;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(otherWorkspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopRequiresModelConfiguration(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-setup-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-setup-data-"));
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    configStore.supportsDetachedRuntimeHost = false;
    const project = await projects.createProject(workspaceRoot);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const unconfigured = structuredClone(defaultConfig);
    unconfigured.defaultModel = "setup-model";
    unconfigured.providers = { setup: { type: "openai-compatible", baseUrl: "https://example.com/v1" } };
    unconfigured.models = { "setup-model": { provider: "setup", model: "setup-model", contextWindow: 128_000, supportsTools: true } };
    unconfigured.thinking = { enabled: false, effort: "high" };
    await configStore.save(unconfigured);
    const initial = await agents.workspaceSnapshot(project.id);
    assert.equal(initial.requiresModelConfiguration, true);
    assert.equal(initial.models[0]?.alias, unconfigured.defaultModel, "saved unavailable models remain visible in settings projections");
    assert.equal(initial.models[0]?.available, false);
    assert.equal(initial.pickerModels.length, 0, "unavailable models stay out of task model pickers");

    const configured = structuredClone(unconfigured);
    configured.providers.setup!.apiKey = "desktop-test-key";
    await configStore.save(configured);
    const ready = await agents.workspaceSnapshot(project.id);
    assert.equal(ready.requiresModelConfiguration, false);
    assert.equal(ready.models[0]?.alias, configured.defaultModel);

    const fallbackAvailable = structuredClone(configured);
    fallbackAvailable.providers.setup!.apiKey = undefined;
    fallbackAvailable.providers.fallback = {
      type: "openai-compatible",
      baseUrl: "https://fallback.example.com/v1",
      apiKey: "desktop-fallback-key"
    };
    fallbackAvailable.models["fallback-model"] = {
      provider: "fallback",
      model: "fallback-model",
      contextWindow: 128_000,
      supportsTools: true
    };
    await configStore.save(fallbackAvailable);
    const fallbackReady = await agents.workspaceSnapshot(project.id);
    assert.equal(fallbackReady.requiresModelConfiguration, false, "another usable model keeps the composer available when the default is unavailable");
    assert.deepEqual(fallbackReady.pickerModels.map((model) => model.alias), ["fallback-model"]);
    assert.deepEqual(fallbackReady.models.map((model) => model.alias), ["setup-model", "fallback-model"]);
    const switched = await agents.switchModel(project.id, "fallback-model", "off");
    assert.equal(switched.modelAlias, "fallback-model", "a usable fallback can be selected before the invalid default runtime initializes");
    assert.equal((await configStore.load()).defaultModel, "fallback-model");
  } finally {
    await agents?.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopConnectionMetadata(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-connections-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-connections-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const modelsStore = new FileModelsStore(path.join(desktopRoot, "models-store.json"));
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined, undefined, modelsStore);
    const config = structuredClone(defaultConfig);
    config.providers.deepseek!.apiKey = "connection-metadata-secret";
    config.providers.subscription = {
      type: "claude-subscription",
      baseUrl: "https://api.anthropic.com",
      apiKey: "oauth-access-token",
      authMode: "oauth-bearer",
      oauth: { provider: "claude-code", expiresAt: 1_900_000_000_000 }
    };
    await configStore.save(config);

    const snapshot = await agents.workspaceSnapshot(project.id);
    const deepseek = snapshot.connections.find((item) => item.providerAlias === "deepseek");
    assert.equal(deepseek?.hasCredential, true);
    assert.equal(deepseek?.credentialSource, process.platform === "darwin" ? "keychain" : "config");
    assert.equal(deepseek?.baseUrl, "https://api.deepseek.com");
    // Presence only — the key itself must never reach the renderer.
    assert.doesNotMatch(JSON.stringify(snapshot.connections), /connection-metadata-secret|oauth-access-token/);

    const subscription = snapshot.connections.find((item) => item.providerAlias === "subscription");
    assert.equal(subscription?.authMode, "oauth-bearer");
    assert.equal(subscription?.oauthProvider, "claude-code");
    assert.equal(subscription?.oauthExpiresAt, 1_900_000_000_000);

    // 刷新失败必须作为失败返回，缓存保持不变，不能伪装成当前账号刚返回的实时目录。
    const unreachable = structuredClone(config);
    unreachable.providers.deepseek!.baseUrl = "http://127.0.0.1:1/v1";
    unreachable.providers.deepseek!.retry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    await configStore.save(unreachable);
    await modelsStore.write("deepseek", {
      models: [{
        id: "cached-deepseek-model",
        displayName: "Cached DeepSeek Model",
        provider: "deepseek",
        contextWindow: 64_000,
        maxOutputTokens: 8_000,
        capabilities: { tools: true, streaming: true },
        reasoningEfforts: []
      }]
    });
    const settingsSnapshot = await agents.settingsConfigSnapshot(project.id);
    assert.deepEqual(settingsSnapshot.models.catalogs?.deepseek?.map((model) => model.id), ["cached-deepseek-model"]);
    await assert.rejects(
      agents.fetchModelCatalog(project.id, "deepseek"),
      /无法从服务商获取模型列表/u
    );
    assert.deepEqual((await modelsStore.read("deepseek"))?.models.map((model) => model.id), ["cached-deepseek-model"]);
    // 未知/自定义 provider 没有实时目录可言：返回静态空目录而非抛错，详情层静默预取不应刷错误。
    const missing = await agents.fetchModelCatalog(project.id, "missing-provider");
    assert.equal(missing.source, "static");
    assert.deepEqual(missing.models, []);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopCodexLoginCallbackLifecycle(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let discoveredModels: Array<{ slug: string; visibility?: string }> = [{ slug: "gpt-5.3-codex" }];
  globalThis.fetch = (async (input): Promise<Response> => {
    const url = String(input);
    if (url === "https://auth.openai.com/oauth/token") {
      return new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3_600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) {
      return new Response(JSON.stringify({ models: discoveredModels }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch in login test: ${url}`);
  }) as typeof fetch;

  const openedUrls: string[] = [];
  const service = new DesktopModelLoginService(async (url) => { openedUrls.push(url); });
  try {
    const started = await service.start("openai-codex");
    const authorizationUrl = new URL(openedUrls[0]!);
    const completing = service.complete("openai-codex", started.authRequestId);
    const callbackResponse = await originalFetch(
      `http://localhost:1455/auth/callback?code=authorization-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}`
    );
    assert.equal(callbackResponse.status, 200);
    const authenticated = await completing;
    assert.equal(authenticated.models, undefined);
    const discovered = await service.discoverModels("openai-codex", authenticated.accessToken);
    assert.equal(discovered[0]?.id, "gpt-5.3-codex");
    await assert.rejects(
      service.complete("openai-codex", started.authRequestId),
      /授权会话不存在/
    );

    const failedStart = await service.start("openai-codex");
    const failedAuthorizationUrl = new URL(openedUrls[1]!);
    discoveredModels = [];
    const completedWithoutCatalog = service.complete("openai-codex", failedStart.authRequestId);
    const failedCallbackResponse = await originalFetch(
      `http://localhost:1455/auth/callback?code=authorization-code&state=${encodeURIComponent(failedAuthorizationUrl.searchParams.get("state") ?? "")}`
    );
    assert.equal(failedCallbackResponse.status, 200);
    const authenticatedWithoutCatalog = await completedWithoutCatalog;
    assert.equal((await service.discoverModels("openai-codex", authenticatedWithoutCatalog.accessToken)).length, 0);
    await assert.rejects(
      service.complete("openai-codex", failedStart.authRequestId),
      /授权会话不存在/
    );

    const cancelledStart = await service.start("openai-codex");
    service.cancel("openai-codex", cancelledStart.authRequestId);
    await assert.rejects(
      service.complete("openai-codex", cancelledStart.authRequestId),
      /授权会话不存在/
    );
  } finally {
    globalThis.fetch = originalFetch;
    service.cancel("openai-codex", "cleanup");
  }
}

async function testDesktopOAuthCommitSurvivesCatalogFailure(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-oauth-commit-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-oauth-commit-data-"));
  const originalFetch = globalThis.fetch;
  let agents: DesktopAgentManager | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const openedUrls: string[] = [];
    const fetcher = (async (input): Promise<Response> => {
      const url = String(input);
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3_600 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) throw new Error("catalog temporarily unavailable");
      throw new Error(`unexpected fetch in OAuth commit test: ${url}`);
    }) as typeof fetch;
    agents = new DesktopAgentManager(
      state,
      projects,
      configStore,
      () => undefined,
      async (url) => { openedUrls.push(url); },
      undefined,
      fetcher
    );

    const started = await agents.startModelLogin(project.id, "openai-codex");
    const authorizationUrl = new URL(openedUrls[0]!);
    const completing = agents.completeModelLoginForSettings(project.id, "openai-codex", started.authRequestId);
    const callbackResponse = await originalFetch(
      `http://localhost:1455/auth/callback?code=authorization-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}`
    );
    assert.equal(callbackResponse.status, 200);
    const staged = await completing;
    const settings = new DesktopSettingsTransaction(state, agents);
    const snapshot = await commitDesktopSettings(settings, project.id, {
      models: { upserts: [], removeAliases: [], oauthCredentialHandles: [staged.handle] }
    });
    const configured = await configStore.load(project.path);
    assert.equal(configured.providers["openai-codex"]?.type, "openai-codex");
    assert.equal(snapshot.models.connections.find((connection) => connection.providerAlias === "openai-codex")?.authMode, "oauth-bearer");
    assert.match(configured.defaultModel, /^openai-codex-/u);
    assert.deepEqual(
      Object.values(configured.models)
        .filter((model) => model.provider === "openai-codex")
        .map((model) => model.model),
      openAiCodexCatalogModels.map((model) => model.id)
    );
  } finally {
    await agents?.closeAll();
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testWorkspaceSnapshotDoesNotReorderProjects(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-b-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await projects.createProject(secondRoot);
    const firstOpenedAt = state.project(first.id)?.lastOpenedAt;
    const secondOpenedAt = state.project(second.id)?.lastOpenedAt;
    assert.ok(firstOpenedAt);
    assert.ok(secondOpenedAt);
    assert.notEqual(firstOpenedAt, secondOpenedAt);

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.workspaceSnapshot(first.id);

    assert.equal(state.project(first.id)?.lastOpenedAt, firstOpenedAt);
    assert.equal(state.project(second.id)?.lastOpenedAt, secondOpenedAt);
    assert.deepEqual(state.projects().map((project) => project.id), [first.id, second.id]);
  } finally {
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopNavigationReadsDoNotPersistSelection(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-selection-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-selection-b-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-selection-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    assert.equal(state.activeProjectId(), undefined, "upserting projects must not select them");

    await state.commitSelection(second.id, "session-second", "runtime");
    const firstDataRoot = await projects.dataRoot(first);
    await ensureAgentDirs(firstDataRoot);
    const recorder = new SessionRecorder(firstDataRoot, "session-first");
    recorder.record({ type: "user_message", content: "keep the prior selection" });
    await recorder.close();

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const beforeDraft = await agents.workspaceSnapshot(first.id);
    const draft = await agents.startDraft(first.id);
    assert.deepEqual(
      draft.sessions.map((session) => session.id),
      beforeDraft.sessions.map((session) => session.id),
      "starting a draft must not create a session or send a message"
    );
    await agents.openSession(first.id, "session-first");
    assert.equal(state.activeProjectId(), second.id);
    assert.equal(state.selectedSessionId(second.id), "session-second");
    assert.equal(state.activeView(), "runtime");
    assert.equal(state.selectedSessionId(first.id), undefined, "navigation reads wait for the Renderer commit");

    await state.commitSelection(first.id, "session-first", "chat");
    const restored = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
    await restored.load();
    assert.equal(restored.activeProjectId(), first.id);
    assert.equal(restored.selectedSessionId(first.id), "session-first");
    assert.equal(restored.activeView(), "chat");
    await assert.rejects(state.commitSelection("missing-project", undefined, "chat"), /Unknown project/);
    assert.equal(state.activeProjectId(), first.id);
    await agents.closeAll();
  } finally {
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopSidebarListsEveryProjectSession(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-b-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sidebar-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    for (const [project, sessionId] of [[first, "first-session"], [second, "second-session"]] as const) {
      const dataRoot = await projects.dataRoot(project);
      await ensureAgentDirs(dataRoot);
      const recorder = new SessionRecorder(dataRoot, sessionId);
      recorder.record({ type: "user_message", content: `Task for ${project.name}` });
      await recorder.close();
    }

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const workspace = await agents.workspaceSnapshot(first.id);
    const sessions = await agents.sidebarSessions(workspace);
    assert.deepEqual(new Set(sessions.map((session) => session.projectId)), new Set([first.id, second.id]));
    assert.deepEqual(new Set(sessions.map((session) => session.id)), new Set(["first-session", "second-session"]));
    await agents.closeAll();
  } finally {
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testDesktopProjectReorder(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-b-"));
  const thirdRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-c-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-data-"));
  try {
    const { projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    const third = await projects.createProject(thirdRoot);
    assert.deepEqual(state.projects().map((project) => project.id), [first.id, second.id, third.id]);

    await state.reorderProjects([third.id, first.id, second.id]);
    assert.deepEqual(state.projects().map((project) => project.id), [third.id, first.id, second.id]);

    await state.reorderProjects([second.id, "missing-project", first.id]);
    assert.deepEqual(state.projects().map((project) => project.id), [second.id, first.id, third.id]);

    // Drag-down semantics: insert after target so moving first→second actually changes order.
    assert.deepEqual(
      reorderSectionProjectIdsForTest([first.id, second.id, third.id], [first.id, second.id, third.id], first.id, second.id, "after"),
      [second.id, first.id, third.id]
    );
    // Drag-up semantics: insert before target.
    assert.deepEqual(
      reorderSectionProjectIdsForTest([first.id, second.id, third.id], [first.id, second.id, third.id], third.id, first.id, "before"),
      [third.id, first.id, second.id]
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(secondRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(thirdRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(desktopRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function reorderSectionProjectIdsForTest(
  fullIds: string[],
  sectionIds: string[],
  sourceId: string,
  targetId: string,
  placement: "before" | "after"
): string[] {
  const nextSection = sectionIds.filter((projectId) => projectId !== sourceId);
  const targetIndex = nextSection.indexOf(targetId);
  if (targetIndex < 0) return fullIds;
  nextSection.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  const sectionMembers = new Set(sectionIds);
  let sectionIndex = 0;
  return fullIds.map((projectId) => sectionMembers.has(projectId) ? nextSection[sectionIndex++]! : projectId);
}

async function createDesktopTestServices(root: string): Promise<{
  configStore: ReturnType<typeof createFileConfigStore>;
  projects: DesktopProjectService;
  state: DesktopStateStore;
}> {
  const storage = new DesktopUserDataStore(root);
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const testCredentials = new Map<string, string>();
  const configStore = createFileConfigStore(root, {
    globalDir: root,
    credentialStore: {
      persistent: true,
      get: async (account) => testCredentials.get(account),
      set: async (account, value) => { testCredentials.set(account, value); },
      delete: async (account) => { testCredentials.delete(account); }
    }
  });
  // 通过测试凭据存储注入 key，让 runtime 能在没有任何环境变量的机器上初始化；生产实现使用
  // macOS Keychain，配置文件本身不会包含明文 key。
  await configStore.save({
    ...defaultConfig,
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
    models: { "test-model": { provider: "active", model: "test-model", contextWindow: 128_000 } },
    thinking: { ...defaultConfig.thinking, enabled: false }
  });
  return { configStore, projects: new DesktopProjectService(state, storage, configStore), state };
}

async function commitDesktopSettings(
  settings: DesktopSettingsTransaction,
  projectId: string,
  input: Omit<DesktopSettingsSaveInput, "expectedPreferenceRevision" | "expectedConfigRevision">
): Promise<DesktopSettingsSnapshot> {
  const current = await settings.snapshot(projectId);
  const result = await settings.save(projectId, settingsSaveInputSchema.parse({
    ...input,
    expectedPreferenceRevision: current.preferenceRevision,
    expectedConfigRevision: current.configRevision
  }));
  if (result.status !== "committed") {
    throw new Error(`Expected settings commit, received ${result.status}: ${result.message ?? ""}`);
  }
  return result.snapshot;
}

function testProviderCatalogResolution(): void {
  // A relay / self-hosted gateway matches no catalog vendor. It used to fall
  // back to "the first openai-compatible entry", which branded a grok endpoint
  // at ai.td.ee as MiniMax Coding Plan and offered MiniMax M3 as a candidate.
  const relay = { provider: "ai-td-ee", providerType: "openai-compatible" };
  assert.equal(catalogForConnection(relay, "https://ai.td.ee/v1"), undefined);
  const custom = customCatalogEntry({ ...relay, models: [] }, "https://ai.td.ee/v1");
  assert.equal(custom.label, "ai.td.ee");
  assert.equal(custom.iconTone, "compatible");
  assert.equal(custom.models.length, 0);
  // 创建对话框命名的服务商：显示名优先于端点主机名。
  const named = customCatalogEntry({ ...relay, displayName: "我的中转", models: [] }, "https://ai.td.ee/v1");
  assert.equal(named.label, "我的中转");
  assert.equal(named.description, "https://ai.td.ee/v1");

  // Known vendors still resolve, and the saved endpoint disambiguates two
  // catalog entries that share a hostname. Vendors outside the trimmed
  // mainstream catalog must resolve to undefined instead of a wrong vendor.
  assert.equal(catalogForConnection({ provider: "api-x-ai", providerType: "openai-compatible" }), undefined);
  const codex = catalogForConnection({ provider: "openai-codex", providerType: "openai-codex" });
  assert.deepEqual(codex?.models.map((model) => model.id), openAiCodexCatalogModels.map((model) => model.id));
  assert.equal(
    catalogForConnection({ provider: "api-z-ai", providerType: "openai-compatible" }, "https://api.z.ai/api/coding/paas/v4")?.id,
    "zai-coding-plan"
  );
  assert.equal(catalogForConnection({ provider: "zai", providerType: "zai" })?.id, "zai");
  const deepseekSeed = providerCatalog.find((provider) => provider.id === "deepseek")?.models[0];
  assert.equal(deepseekSeed?.contextWindow, 1_000_000);
  assert.deepEqual(deepseekSeed?.thinkingLevelMap, { off: "none", high: "high", max: "max" });
}

function testSettingsModelThinkingProjection(): void {
  const saved = {
    alias: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    provider: "deepseek",
    providerType: "deepseek",
    model: "deepseek-v4-flash",
    modelKey: "deepseek\u0000deepseek-v4-flash",
    capabilities: { tools: true, reasoning: false, reasoningStream: false, reasoningSummary: false, vision: false, audio: false, streaming: true },
    efforts: ["high", "max"] as const,
    defaultThinking: "high" as const,
    thinkingLevelMap: { off: "none", high: "high", max: "max" },
    available: true,
    source: "configured" as const
  };
  const healed = stagedModelChoices([saved], [], [], {})[0];
  assert.deepEqual(healed?.thinkingLevelMap, {
    off: "none",
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max"
  });
  assert.deepEqual(healed?.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);

  const explicit = stagedModelChoices([saved], [], [], {
    deepseek: {
      "deepseek-v4-flash": {
        contextWindow: 512_000,
        maxInputTokens: 480_000,
        maxOutputTokens: 96_000,
        thinkingLevelMap: { off: "none", high: "gateway-high", max: "gateway-max" }
      }
    }
  })[0];
  assert.deepEqual(explicit?.thinkingLevelMap, { off: "none", high: "gateway-high", max: "gateway-max" });
  assert.equal(explicit?.contextWindow, 512_000);
  assert.equal(explicit?.maxInputTokens, 480_000);
  assert.equal(explicit?.maxOutputTokens, 96_000);
  assert.equal(explicit?.contextWindowIsFallback, false);
}

function testComposerThinkingLabels(): void {
  assert.equal(composerThinkingLabel("off"), "Off");
  assert.equal(composerThinkingLabel("low"), "Low");
  assert.equal(composerThinkingLabel("medium"), "Medium");
  assert.equal(composerThinkingLabel("high"), "High");
  assert.equal(composerThinkingLabel("xhigh"), "XHigh");
  assert.equal(composerThinkingLabel("max"), "Max");
}

function testModelChoicesDeduplicateEquivalentAliases(): void {
  const config = structuredClone(defaultConfig);
  const unavailable = structuredClone(defaultConfig);
  unavailable.providers.deepseek!.apiKey = undefined;
  unavailable.providers.deepseek!.apiKeyEnv = "BINY_TEST_MISSING_MODEL_KEY";
  delete process.env.BINY_TEST_MISSING_MODEL_KEY;
  assert.equal(listConfiguredModelChoices(unavailable).length, 2, "saved models remain visible when credentials are unavailable");
  assert.equal(listConfiguredModelChoices(unavailable).every((model) => !model.available), true);
  config.providers.deepseek!.apiKey = "test-key";
  // 实时快照会新增模型；这里验证重复 alias 不改变目录，不固定上游模型清单。
  const baselineAliases = listModelChoices(config).map((model) => model.alias);
  config.models["deepseek-deepseek-v4-flash"] = { ...config.models["deepseek-v4-flash"] };
  assert.deepEqual(listModelChoices(config).map((model) => model.alias), baselineAliases);
  assert.deepEqual(listConfiguredModelChoices(config).map((model) => model.alias), [
    "deepseek-v4-flash",
    "deepseek-v4-pro"
  ]);
  assert.deepEqual(listPickerModelChoices(config).map((model) => model.alias), [
    "deepseek-v4-flash",
    "deepseek-v4-pro"
  ]);
  const deepseekChoice = listPickerModelChoices(config).find((model) => model.alias === "deepseek-v4-flash");
  assert.equal(deepseekChoice?.contextWindow, 1_000_000);
  assert.equal(deepseekChoice?.toolSchemaReserveTokens, 1_024);
  assert.equal(deepseekChoice?.outputReserveTokens, 250_000);
  assert.equal(deepseekChoice?.systemPromptReserveTokens, 1_024);
  const legacyHostChoices = listModelChoices(config).map((model) => ({ ...model, showInPicker: undefined }));
  assert.deepEqual(filterPickerModelChoices(legacyHostChoices).map((model) => model.alias), [
    "deepseek-v4-flash",
    "deepseek-v4-pro"
  ]);

  const disabledConfig = structuredClone(config);
  disabledConfig.providers.deepseek!.modelProfiles = { "deepseek-v4-flash": { showInPicker: false } };
  assert.equal(listConfiguredModelChoices(disabledConfig).some((model) => model.alias === "deepseek-v4-flash"), true);
  assert.equal(listPickerModelChoices(disabledConfig).some((model) => model.alias === "deepseek-v4-flash"), false);

  const multiProviderConfig = structuredClone(config);
  multiProviderConfig.providers["opencode-ai"] = {
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "test-key"
  };
  multiProviderConfig.models["opencode-ai-minimax-m3"] = {
    provider: "opencode-ai",
    model: "minimax-m3"
  };
  const catalogModel: ModelCatalogEntry = {
    id: "minimax-m2.7",
    displayName: "MiniMax-M2.7",
    provider: "opencode-ai",
    contextWindow: 1_000_000,
    maxInputTokens: 900_000,
    maxOutputTokens: undefined,
    capabilities: { tools: true },
    reasoningEfforts: [],
    reasoningEffortsSource: "declared"
  };
  const multiProviderChoices = listPickerModelChoices(multiProviderConfig, [["opencode-ai", [catalogModel]]]);
  assert.deepEqual(multiProviderChoices.map((model) => model.alias), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "opencode-ai-minimax-m3"
  ]);
  assert.equal(multiProviderChoices.find((model) => model.alias === "opencode-ai-minimax-m3")?.capabilities?.reasoning, true);
  // minimax 事实已随精简退出 models.dev 快照；这里退化为按模型 ID 家族推断的档位，
  // 并按原生值去重后只保留 high/max 两个代表档位。
  assert.deepEqual(multiProviderChoices.find((model) => model.alias === "opencode-ai-minimax-m3")?.efforts, [
    "high",
    "max"
  ]);
  assert.equal(multiProviderChoices.find((model) => model.alias === "opencode-ai-minimax-m3")?.defaultThinking, "high");
  assert.equal(multiProviderChoices.some((model) => model.alias === "opencode-ai/minimax-m2.7"), false);
  const configuredCatalogModel: ModelCatalogEntry = { ...catalogModel, id: "minimax-m3", displayName: "MiniMax-M3" };
  const configuredChoices = listConfiguredModelChoices(multiProviderConfig, [[
    "opencode-ai",
    [catalogModel, configuredCatalogModel]
  ]]);
  const configuredChoice = configuredChoices.find((model) => model.alias === "opencode-ai-minimax-m3");
  assert.equal(configuredChoice?.contextWindow, 1_000_000);
  assert.equal(configuredChoice?.inputBudgetTokens, 900_000);
}

function testHistoricalAbortProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "sleep", time: "2026-01-01T00:00:00.000Z" },
    { type: "tool_call", tool: "Bash", args: { command: "sleep 20" }, toolCallId: "tool-1", sequence: 1 },
    { type: "tool_result", tool: "Bash", result: { stdout: "", stderr: "Command interrupted.", exitCode: 1 }, toolCallId: "tool-1", sequence: 1 },
    { type: "error", message: "This operation was aborted" }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.status, "aborted");
  assert.equal(timeline[0]?.tools[0]?.status, "unknown");
}

function testHistoricalUsageProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "hello" },
    {
      type: "assistant_message",
      content: "hi",
      usage: {
        operation: "agent",
        modelAlias: "primary",
        provider: "openai",
        model: "gpt-test",
        totalTokens: 42,
        pricingKnown: false
      }
    }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.model?.alias, "primary");
  assert.equal(timeline[0]?.model?.label, "openai/gpt-test");
  assert.equal(timeline[0]?.usage?.totalTokens, 42);

  const document: DesktopSessionDocument = {
    session: {} as DesktopSessionSummary,
    events: [{
      type: "assistant_message",
      content: "hi",
      usage: {
        operation: "agent",
        modelAlias: "primary",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 978_146,
        latestRequestInputTokens: 18_061,
        totalTokens: 982_201,
        pricingKnown: false
      }
    }],
    liveEvents: []
  };
  assert.equal(lastReportedInputTokens(document), 18_061);
}

/** 时间线只展示活动回答，但保留版本计数与切换锚点。 */
function testMessageVersionTimelineProjection(): void {
  const assistant = (messageId: string, text: string): Extract<SessionEvent, { type: "agent_message" }> => ({
    type: "agent_message",
    message: { role: "assistant", content: [{ type: "text", text }] },
    messageId,
    parentMessageId: "user-1",
    slotId: "slot-1"
  });
  const flat = (messageId: string, content: string, retryOfMessageId?: string): Extract<SessionEvent, { type: "assistant_message" }> => ({
    type: "assistant_message",
    content,
    messageId,
    parentMessageId: "user-1",
    slotId: "slot-1",
    replyToMessageId: "user-1",
    retryOfMessageId
  });
  const events: SessionEvent[] = [
    { type: "user_message", content: "same prompt", messageId: "user-1", slotId: "user-1" },
    assistant("assistant-1", "first answer"),
    flat("assistant-1", "first answer"),
    assistant("assistant-2", "second answer"),
    flat("assistant-2", "second answer", "assistant-1")
  ];
  const latest = buildSessionTimeline(events, [])[0];
  assert.equal(latest?.user, "same prompt");
  assert.equal(latest?.assistant, "second answer");
  assert.equal(latest?.assistantMessageId, "assistant-2");
  assert.equal(latest?.versionIndex, 1);
  assert.equal(latest?.versionCount, 2);

  const previous = buildSessionTimeline([
    ...events,
    { type: "message_version_selected", messageId: "assistant-1", slotId: "slot-1" }
  ], [])[0];
  assert.equal(previous?.assistant, "first answer");
  assert.equal(previous?.assistantMessageId, "assistant-1");
  assert.equal(previous?.versionIndex, 0);
  assert.equal(previous?.versionCount, 2);

  const edited = buildSessionTimeline([
    ...events,
    { type: "user_message", content: "edited prompt", messageId: "user-2", slotId: "user-1" },
    {
      type: "agent_message",
      message: { role: "assistant", content: [{ type: "text", text: "edited answer" }] },
      messageId: "assistant-3",
      parentMessageId: "user-2",
      slotId: "slot-1"
    },
    {
      type: "assistant_message",
      content: "edited answer",
      messageId: "assistant-3",
      parentMessageId: "user-2",
      slotId: "slot-1",
      replyToMessageId: "user-2",
      retryOfMessageId: "user-1"
    },
    { type: "message_version_selected", messageId: "assistant-3", slotId: "slot-1" }
  ], [])[0];
  assert.equal(edited?.user, "edited prompt");
  assert.equal(edited?.assistant, "edited answer");
  assert.equal(edited?.assistantMessageId, "assistant-3");
  assert.equal(edited?.versionIndex, 2);
  assert.equal(edited?.versionCount, 3);
}

/** 实时重试必须替换原 turn，并隐藏目标之后仍属于旧分支的历史轮次。 */
function testLiveRetryReplacesTargetTurn(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "first prompt", messageId: "user-1", slotId: "user-1" },
    {
      type: "agent_message",
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      messageId: "assistant-1",
      parentMessageId: "user-1",
      slotId: "slot-1"
    },
    {
      type: "assistant_message",
      content: "old answer",
      messageId: "assistant-1",
      parentMessageId: "user-1",
      slotId: "slot-1",
      replyToMessageId: "user-1"
    },
    { type: "user_message", content: "later prompt", messageId: "user-2", parentMessageId: "assistant-1" },
    {
      type: "agent_message",
      message: { role: "assistant", content: [{ type: "text", text: "later answer" }] },
      messageId: "assistant-2",
      parentMessageId: "user-2"
    },
    {
      type: "assistant_message",
      content: "later answer",
      messageId: "assistant-2",
      parentMessageId: "user-2",
      replyToMessageId: "user-2"
    }
  ];
  const liveEvents: AgentHostEvent[] = [
    {
      type: "run.started",
      runId: "retry-run",
      sessionId: "session-1",
      messageId: "assistant-3",
      retryOfMessageId: "assistant-1",
      timestamp: "2026-09-08T10:00:00.000Z"
    },
    {
      type: "assistant.delta",
      runId: "retry-run",
      content: "new answer",
      timestamp: "2026-09-08T10:00:01.000Z"
    },
    {
      type: "assistant.completed",
      runId: "retry-run",
      content: "new answer",
      timestamp: "2026-09-08T10:00:02.000Z"
    },
    {
      type: "run.completed",
      runId: "retry-run",
      sessionId: "session-1",
      timestamp: "2026-09-08T10:00:02.000Z"
    }
  ];
  const turns = buildSessionTimeline(events, liveEvents);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user, "first prompt");
  assert.equal(turns[0]?.assistant, "new answer");
  assert.equal(turns[0]?.assistantMessageId, "assistant-3");
  assert.equal(turns[0]?.retryOfMessageId, "assistant-1");
  assert.equal(turns[0]?.versionIndex, 1);
  assert.equal(turns[0]?.versionCount, 2);
}

function testDesktopUsagePresentation(): void {
  assert.equal(formatUsageCost({ calls: 1, costUsd: 0.000002, pricingKnown: true }), "$0.000002");
  assert.equal(formatUsageCost({ calls: 2, costUsd: 0.000002, pricingKnown: false }), "未知");
  assert.equal(formatUsageCost({ calls: 0, costUsd: undefined, pricingKnown: false }), "—");

  const context = formatContextUsage({ usedTokens: 109_000, contextWindow: 1_000_000, source: "provider" });
  assert.equal(context?.percent, 10.9);
  assert.equal(context?.max, "1,000,000");
  assert.equal(context?.compactUsed, "10.9万");
  assert.equal(context?.estimated, false);

}

function testHistoricalToolProjection(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "read" },
    { type: "tool_call", tool: "Read", args: { path: "src/index.ts" }, toolCallId: "tool" },
    { type: "tool_result", tool: "Read", result: { path: "src/index.ts", content: "hello" }, toolCallId: "tool" }
  ], []);
  assert.equal(timeline[0]?.tools[0]?.path, "src/index.ts");
  assert.deepEqual(timeline[0]?.tools[0]?.display, { kind: "file_io", operation: "read", path: "src/index.ts" });
}

/** 自动记忆属于后台元数据，不应制造聊天轮次或时间线步骤。 */
function testMemoryMetadataStaysOutOfTimeline(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "记住我喜欢简短回答" },
    { type: "assistant_message", content: "好，我记住了" },
    {
      type: "message_metadata",
      messageId: "assistant-1",
      metadata: {
        memoryExtracted: true,
        createdMemories: [{ id: "memory-1", content: "用户偏好简短回答" }],
        deletedMemories: []
      }
    },
    { type: "user_message", content: "继续" },
    { type: "assistant_message", content: "继续处理" }
  ], []);

  assert.deepEqual(timeline.map((turn) => [turn.user, turn.assistant]), [
    ["记住我喜欢简短回答", "好，我记住了"],
    ["继续", "继续处理"]
  ]);
  assert.equal(JSON.stringify(timeline).includes("memory-1"), false);
}

function testWebSearchProjection(): void {
  const searchResult = {
    query: "Chicago weather",
    provider: "tavily",
    results: [
      { title: "Chicago Forecast", url: "https://www.weather.gov/chicago", snippet: "Official forecast.", favicon: "https://www.weather.gov/favicon.ico" },
      { title: "HTTP favicon", url: "https://example.com/http-favicon", favicon: "http://tracker.example.com/pixel.ico" },
      { title: "Broken entry", url: "not-a-url" },
      { title: "FTP entry", url: "ftp://example.com/file" }
    ],
    fetchedAt: "2026-01-01T00:00:03.000Z"
  };
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "查天气" },
    { type: "tool_call", tool: "WebSearch", args: { query: "Chicago weather" }, toolCallId: "search" },
    { type: "tool_result", tool: "WebSearch", result: searchResult, toolCallId: "search" }
  ], []);
  const tool = timeline[0]?.tools[0];
  assert.equal(tool?.status, "success");
  assert.deepEqual(tool?.display, { kind: "generic", summary: "Chicago weather", detail: { query: "Chicago weather" } });

  const view = projectWebSearchView(tool?.args, tool?.result);
  assert.equal(view.query, "Chicago weather");
  assert.equal(view.providerLabel, "Tavily");
  assert.equal(view.fetchedAt, "2026-01-01T00:00:03.000Z");
  // 非法 URL 与非 http(s) 协议的结果不进入视图。
  assert.equal(view.results.length, 2);
  assert.equal(view.results[0]?.domain, "weather.gov");
  assert.equal(view.results[0]?.fallbackLetter, "W");
  assert.deepEqual(view.results[0]?.faviconCandidates, [
    "https://www.weather.gov/favicon.ico",
    "https://icons.duckduckgo.com/ip3/www.weather.gov.ico",
    "https://www.google.com/s2/favicons?domain=www.weather.gov&sz=64"
  ]);
  // 明文 http favicon 不进入回退链，直接落到图标服务。
  assert.deepEqual(view.results[1]?.faviconCandidates, [
    "https://icons.duckduckgo.com/ip3/example.com.ico",
    "https://www.google.com/s2/favicons?domain=example.com&sz=64"
  ]);

  // 运行中（尚无结果）时只有查询词，provider 未知。
  const runningView = projectWebSearchView({ query: "Chicago weather" }, undefined);
  assert.equal(runningView.query, "Chicago weather");
  assert.equal(runningView.providerLabel, undefined);
  assert.equal(runningView.results.length, 0);
}

function testHistoricalReasoningAndSkillProjection(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "explain", skills: [".agent/skills/programmatic-tools/SKILL.md"], time: "2026-01-01T00:00:00.000Z" },
    { type: "tool_call", tool: "Skill", args: { skill: "programmatic-tools" }, toolCallId: "skill", time: "2026-01-01T00:00:00.500Z" },
    { type: "tool_result", tool: "Skill", result: { instructions: "Use tools." }, toolCallId: "skill", time: "2026-01-01T00:00:00.750Z" },
    { type: "tool_call", tool: "Bash", args: { command: "pwd" }, reasoningContent: "先确认当前工作目录。", time: "2026-01-01T00:00:01.000Z" },
    { type: "assistant_message", content: "done", reasoningContent: "然后整理结果。", time: "2026-01-01T00:00:02.512Z" }
  ], []);
  assert.deepEqual(timeline[0]?.skills, ["programmatic-tools"]);
  assert.equal(timeline[0]?.reasoning, "先确认当前工作目录。\n\n然后整理结果。");
  assert.equal(timeline[0]?.durationMs, 2_512);
}

function testExecutionTimelineKeepsReasoningAndToolsInOrder(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "inspect and test" },
    { type: "tool_call", tool: "Read", args: { path: "src/index.ts" }, toolCallId: "read", assistantContent: "先检查入口。", reasoningContent: "先确认入口文件。" },
    { type: "tool_result", tool: "Read", result: { path: "src/index.ts" }, toolCallId: "read" },
    { type: "tool_call", tool: "Bash", args: { command: "pnpm test" }, toolCallId: "test", assistantContent: "再运行测试。", reasoningContent: "根据入口继续验证。" },
    { type: "tool_result", tool: "Bash", result: { exitCode: 0 }, toolCallId: "test" },
    { type: "assistant_message", content: "完成。", reasoningContent: "最后整理结果。" }
  ], []);
  const turn = timeline[0];
  assert.deepEqual(turn?.steps.map((step) => step.kind), ["reasoning", "assistant", "tool", "reasoning", "assistant", "tool", "reasoning", "assistant"]);
  assert.equal(turn?.steps[0]?.kind === "reasoning" ? turn.steps[0].content : undefined, "先确认入口文件。");
  assert.equal(turn?.steps[1]?.kind === "assistant" ? turn.steps[1].summary : undefined, true);
  assert.equal(turn?.steps[2]?.kind === "tool" ? turn.steps[2].tool.id : undefined, "read");
  assert.equal(turn?.steps[4]?.kind === "assistant" ? turn.steps[4].summary : undefined, true);
  assert.equal(turn?.steps[5]?.kind === "tool" ? turn.steps[5].tool.id : undefined, "test");
  assert.equal(turn?.steps[6]?.kind === "reasoning" ? turn.steps[6].content : undefined, "最后整理结果。");
  assert.equal(turn?.assistant, "完成。");
}

function testLiveExecutionTimelineKeepsReasoningAndToolsInOrder(): void {
  const base = { sessionId: "session", runId: "ordered-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "inspect and test" },
    { ...base, type: "run.started", messageId: "message", input: "inspect and test", model: { alias: "test", provider: "test", label: "test/model", reasoning: "High" }, skills: [] },
    { ...base, type: "reasoning.started", phase: "initial" },
    { ...base, timestamp: "2026-01-01T00:00:01.000Z", type: "reasoning.delta", content: "先检查入口。" },
    { ...base, timestamp: "2026-01-01T00:00:02.000Z", type: "reasoning.completed" },
    { ...base, timestamp: "2026-01-01T00:00:03.000Z", type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "src/index.ts" } },
    { ...base, timestamp: "2026-01-01T00:00:04.000Z", type: "tool.completed", toolCallId: "read", tool: "Read", result: {}, durationMs: 1_000 },
    { ...base, timestamp: "2026-01-01T00:00:05.000Z", type: "reasoning.started", phase: "continuing" },
    { ...base, timestamp: "2026-01-01T00:00:06.000Z", type: "reasoning.delta", content: "再运行测试。" },
    { ...base, timestamp: "2026-01-01T00:00:07.000Z", type: "reasoning.completed" },
    { ...base, timestamp: "2026-01-01T00:00:08.000Z", type: "tool.started", toolCallId: "test", tool: "Bash", args: { command: "pnpm test" } },
    { ...base, timestamp: "2026-01-01T00:00:09.000Z", type: "tool.completed", toolCallId: "test", tool: "Bash", result: {}, durationMs: 1_000 },
    { ...base, timestamp: "2026-01-01T00:00:10.000Z", type: "assistant.delta", content: "完成。" },
    { ...base, timestamp: "2026-01-01T00:00:11.000Z", type: "assistant.completed", content: "完成。" },
    { ...base, timestamp: "2026-01-01T00:00:12.000Z", type: "run.completed", durationMs: 12_000 }
  ]);
  const turn = timeline[0];
  assert.deepEqual(turn?.steps.map((step) => step.kind), ["reasoning", "tool", "reasoning", "tool", "assistant"]);
  assert.deepEqual(turn?.steps.filter((step) => step.kind === "reasoning").map((step) => step.content), ["先检查入口。", "再运行测试。"]);
  assert.deepEqual(turn?.steps.filter((step) => step.kind === "tool").map((step) => step.tool.id), ["read", "test"]);
}

function testLiveAssistantCompletionDoesNotDuplicateDelta(): void {
  const base = { sessionId: "session", runId: "duplicate-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "停止进程" },
    { ...base, type: "assistant.delta", content: "正文" },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "BashOutput", args: {} },
    { ...base, type: "tool.completed", toolCallId: "tool", tool: "BashOutput", result: {}, durationMs: 10 },
    { ...base, type: "assistant.completed", content: "正文" },
    { ...base, type: "run.completed", durationMs: 20 }
  ]);
  const turn = timeline[0];
  const assistantSteps = turn?.steps.filter((step) => step.kind === "assistant") ?? [];
  assert.equal(assistantSteps.length, 2);
  assert.equal(assistantSteps[0]?.kind === "assistant" ? assistantSteps[0].summary : undefined, true);
  assert.equal(assistantSteps[0]?.kind === "assistant" ? assistantSteps[0].content : undefined, "正文");
  assert.equal(assistantSteps[1]?.kind === "assistant" ? assistantSteps[1].summary : undefined, undefined);
  assert.equal(assistantSteps[1]?.kind === "assistant" ? assistantSteps[1].content : undefined, "正文");
  assert.equal(turn?.assistant, "正文");
}

function testVerifierPromptIsNotRenderedAsUserMessage(): void {
  const internalPrompt = [
    "关掉它吧",
    "",
    "This is a verifier-driven task. Complete the objective and satisfy every acceptance criterion below.",
    "Task contract type: conversation.",
    "Constraints:\n- Keep all work inside the workspace.",
    "Current plan:\n- [pending] Produce the requested answer or analysis. (required)",
    "Do not claim completion until the workspace and the required checks are actually in a passing state."
  ].join("\n");
  const base = { sessionId: "session", runId: "verifier-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const historical = buildSessionTimeline([{ type: "user_message", content: internalPrompt }], []);
  assert.equal(historical[0]?.user, "关掉它吧");

  const live = buildSessionTimeline([], [{ ...base, type: "message.user", messageId: "message", content: internalPrompt }]);
  assert.equal(live[0]?.user, "关掉它吧");
}

function testHistoricalPrefixKeepsUnpersistedDuplicatePrompt(): void {
  const liveTimestamp = "2026-01-01T00:00:10.000Z";
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "同一个问题", time: "2026-01-01T00:00:00.000Z" },
    { type: "assistant_message", content: "历史回复", time: "2026-01-01T00:00:01.000Z" }
  ], [
    { sessionId: "session", runId: "run", timestamp: liveTimestamp, type: "message.user", messageId: "message", content: "同一个问题" }
  ]);
  assert.deepEqual(timeline.map((turn) => turn.user), ["同一个问题", "同一个问题"]);
  assert.equal(timeline[0]?.assistant, "历史回复");
}

function testHistoricalEmptyAssistantDoesNotEraseReply(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "完成任务" },
    { type: "assistant_message", content: "任务已完成" },
    { type: "assistant_message", content: "", relatedUsage: [] }
  ], []);
  assert.equal(timeline[0]?.assistant, "任务已完成");
}

function testChangedFileProjection(): void {
  const base = { sessionId: "session", runId: "write-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const started = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "write" },
    { ...base, type: "tool.started", toolCallId: "write-tool", tool: "Write", args: { path: "hello.py" }, display: { kind: "file_io", operation: "write", path: "hello.py" } }
  ]);
  assert.equal(started[0]?.tools[0]?.path, "hello.py");
  assert.deepEqual(listChangedFiles(started[0]!), [{ path: "hello.py", operation: "write", status: "writing" }]);

  const completed = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "write" },
    { ...base, type: "tool.started", toolCallId: "write-tool", tool: "Write", args: { path: "hello.py" }, display: { kind: "file_io", operation: "write", path: "hello.py" } },
    { ...base, type: "tool.change_committed", toolCallId: "write-tool", tool: "Write", operationId: "op-write", change: { operation: "create", path: "hello.py", committed: true, diff: "" } },
    { ...base, type: "tool.completed", toolCallId: "write-tool", tool: "Write", result: { path: "hello.py" }, durationMs: 10 }
  ]);
  assert.deepEqual(listChangedFiles(completed[0]!), [{ path: "hello.py", operation: "write", status: "completed" }]);

  const edited = buildSessionTimeline([], [
    { ...base, runId: "edit-run", type: "message.user", messageId: "edit-message", content: "edit" },
    { ...base, runId: "edit-run", type: "tool.started", toolCallId: "edit-tool", tool: "Edit", args: { operation: "update", path: "hello.py" }, display: { kind: "file_io", operation: "update", path: "hello.py" } },
    { ...base, runId: "edit-run", type: "tool.change_committed", toolCallId: "edit-tool", tool: "Edit", operationId: "op-edit", change: { operation: "update", path: "hello.py", committed: true, diff: "" } },
    { ...base, runId: "edit-run", type: "tool.completed", toolCallId: "edit-tool", tool: "Edit", result: { path: "hello.py" }, durationMs: 10 }
  ]);
  assert.deepEqual(listChangedFiles(edited[0]!), [{ path: "hello.py", operation: "edit", status: "completed" }]);
}

function testLiveTimelineProjection(): void {
  const base = { sessionId: "session", runId: "run", timestamp: "2026-01-01T00:00:00.000Z" };
  const live: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "message", content: "edit" },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "Edit", args: { operation: "update", path: "a.ts" } },
    { ...base, type: "tool.change_committed", toolCallId: "tool", tool: "Edit", operationId: "op-edit", change: { operation: "update", path: "a.ts", committed: true, diff: "diff --git a/a.ts b/a.ts\n+const a = 1;" } },
    { ...base, type: "tool.completed", toolCallId: "tool", tool: "Edit", result: { change: { operation: "update", path: "a.ts", committed: true, diff: "diff --git a/a.ts b/a.ts\n+const a = 1;" } }, durationMs: 20 },
    { ...base, type: "assistant.completed", content: "done" },
    { ...base, type: "run.completed", durationMs: 30 }
  ];
  const timeline = buildSessionTimeline([], live);
  assert.equal(timeline[0]?.assistant, "done");
  assert.equal(timeline[0]?.tools[0]?.diff?.includes("a.ts"), true);
  assert.equal(timeline[0]?.status, "completed");

  const successfulCommand = buildSessionTimeline([], [
    { ...base, runId: "successful-command", type: "message.user", messageId: "command-message", content: "run" },
    { ...base, runId: "successful-command", type: "tool.started", toolCallId: "command", tool: "Bash", args: { command: "pnpm test" }, display: { kind: "command", command: "pnpm test", cwd: "/workspace" } },
    { ...base, runId: "successful-command", type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stdout", text: "passed\n" } },
    { ...base, runId: "successful-command", type: "tool.progress", toolCallId: "command", tool: "Bash", update: { kind: "stderr", text: "warning\n" } },
    { ...base, runId: "successful-command", type: "tool.completed", toolCallId: "command", tool: "Bash", result: { exitCode: 0 }, durationMs: 8 }
  ]);
  assert.deepEqual(successfulCommand[0]?.tools[0]?.command, {
    command: "pnpm test",
    cwd: "/workspace",
    stdout: "passed\n",
    stderr: "warning\n",
    exitCode: 0
  });

  const failedCommand = buildSessionTimeline([], [
    { ...base, runId: "failed-command", type: "message.user", messageId: "command-message", content: "run" },
    { ...base, runId: "failed-command", type: "tool.started", toolCallId: "command", tool: "Bash", args: { command: "false" }, display: { kind: "command", command: "false" } },
    { ...base, runId: "failed-command", type: "tool.failed", toolCallId: "command", tool: "Bash", result: { exitCode: 1 }, error: "Command exited with code 1.", durationMs: 8 }
  ]);
  assert.equal(failedCommand[0]?.tools[0]?.status, "failed");

  const typedFailure = buildSessionTimeline([], [
    { ...base, runId: "typed-failure", type: "message.user", messageId: "typed-message", content: "run" },
    { ...base, runId: "typed-failure", type: "tool.started", toolCallId: "typed-command", tool: "Bash", args: { command: "false" }, display: { kind: "command", command: "false" } },
    { ...base, runId: "typed-failure", type: "tool.failed", toolCallId: "typed-command", tool: "Bash", result: { status: "failed", exitCode: 1 }, error: "Command exited with code 1.", durationMs: 8 },
    { ...base, runId: "typed-failure", type: "run.incomplete", durationMs: 30, reason: "Step limit reached.", stopReason: "step_limit", finishReason: "tool-calls", steps: 8 }
  ]);
  assert.equal(typedFailure[0]?.tools[0]?.status, "failed");
  assert.equal(typedFailure[0]?.status, "incomplete");
  assert.equal(typedFailure[0]?.error, "Step limit reached.");
}

function testLiveTimelineCoalescesReasoningDeltas(): void {
  const base = { sessionId: "session", runId: "run", timestamp: "2026-01-01T00:00:00.000Z" };
  const events: AgentHostEvent[] = [
    { ...base, type: "reasoning.started", phase: "initial" },
    { ...base, type: "reasoning.delta", content: "private " },
    { ...base, type: "reasoning.delta", content: "thought" },
    { ...base, type: "reasoning.completed" },
    { ...base, type: "assistant.delta", content: "answer" }
  ];
  const live = liveTimelineEvents(events);
  assert.deepEqual(live.map((event) => event.type), ["reasoning.started", "reasoning.delta", "reasoning.completed", "assistant.delta"]);
  assert.equal(live[1]?.type === "reasoning.delta" ? live[1].content : undefined, "private thought");
}

function testLiveBlockedAndCancelledProjection(): void {
  const base = { sessionId: "session", timestamp: "2026-01-01T00:00:00.000Z" };
  const blocked = buildSessionTimeline([], [
    { ...base, runId: "blocked-run", type: "message.user", messageId: "blocked-message", content: "deploy" },
    {
      ...base,
      runId: "blocked-run",
      type: "run.blocked",
      durationMs: 30,
      reason: "missing_user_input",
      summary: "The target environment is unknown.",
      requiredAction: "Choose staging or production."
    }
  ]);
  assert.equal(blocked[0]?.status, "blocked");
  assert.match(blocked[0]?.error ?? "", /target environment/u);
  assert.match(blocked[0]?.error ?? "", /Choose staging or production/u);

  const cancelled = buildSessionTimeline([], [
    { ...base, runId: "cancelled-run", type: "message.user", messageId: "cancelled-message", content: "deploy" },
    {
      ...base,
      runId: "cancelled-run",
      type: "run.cancelled",
      durationMs: 10,
      reason: "Cancelled by user."
    }
  ]);
  assert.equal(cancelled[0]?.status, "cancelled");
  assert.equal(cancelled[0]?.error, "Cancelled by user.");
}

function testTerminalRunEventClassification(): void {
  const base = { sessionId: "session", runId: "run", timestamp: "2026-01-01T00:00:00.000Z" };
  const terminal: AgentHostEvent[] = [
    { ...base, type: "run.completed", durationMs: 1 },
    { ...base, type: "run.blocked", durationMs: 1, reason: "missing_dependency", summary: "Install pnpm." },
    { ...base, type: "run.incomplete", durationMs: 1, reason: "Hard limit reached.", stopReason: "step_limit", steps: 10 },
    { ...base, type: "run.cancelled", durationMs: 1, reason: "Cancelled by user." },
    { ...base, type: "run.aborted", durationMs: 1, reason: "Host closed." },
    { ...base, type: "run.failed", durationMs: 1, error: "Provider failed." }
  ];
  assert.equal(terminal.every(isTerminalRunEvent), true);
  assert.equal(isTerminalRunEvent({
    ...base,
    type: "run.started",
    messageId: "message",
    input: "run",
    model: { alias: "test", provider: "test", label: "test/model", reasoning: "Off" },
    skills: []
  }), false);
}

function testLiveReasoningAndSkillProjection(): void {
  const live: AgentHostEvent[] = [
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:00.000Z", type: "message.user", messageId: "message", content: "explain" },
    {
      sessionId: "session",
      runId: "reasoning-run",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run.started",
      messageId: "message",
      input: "explain",
      model: { alias: "test", provider: "test", label: "test/model", reasoning: "High" },
      skills: [".agent/skills/programmatic-tools/SKILL.md"]
    },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:00.500Z", type: "tool.started", toolCallId: "skill", tool: "Skill", args: { skill: "programmatic-tools" } },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:00.750Z", type: "tool.completed", toolCallId: "skill", tool: "Skill", result: { instructions: "Use tools." } },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:01.000Z", type: "reasoning.started", phase: "initial" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:02.512Z", type: "reasoning.delta", content: "先拆分问题。" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:02.512Z", type: "reasoning.completed" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:03.000Z", type: "run.completed", durationMs: 3_000 }
  ];
  const timeline = buildSessionTimeline([], live);
  assert.deepEqual(timeline[0]?.skills, ["programmatic-tools"]);
  assert.equal(timeline[0]?.reasoning, "先拆分问题。");
  assert.equal(timeline[0]?.reasoningDurationMs, 1_512);
}

function testReasoningDetailDoesNotUseCompletionStatusAsContent(): void {
  assert.equal(reasoningDetailText({ content: "  先检查入口。  " }), "先检查入口。");
  // 模型没回传思考内容时返回空串，由展示层折叠成纯状态行，不渲染占位句。
  assert.equal(reasoningDetailText({ content: "" }), "");
  assert.equal(reasoningDetailText({ content: "   " }), "");
}

function testDesktopNavigationHistory(): void {
  const first = { projectId: "project", sessionId: "first" };
  const second = { projectId: "project", sessionId: "second" };
  const draft = { projectId: "project", sessionId: undefined };
  let state = createNavigationState();
  state = pushNavigation(state, first);
  state = pushNavigation(state, second);
  assert.equal(canNavigateBack(state), true);
  assert.equal(canNavigateForward(state), false);

  const back = moveNavigation(state, -1);
  assert.deepEqual(back.target, first);
  state = back.state;
  state = pushNavigation(state, draft);
  assert.equal(canNavigateForward(state), false);
  assert.deepEqual(state.entries, [first, draft]);
  state = replaceNavigation(state, second);
  assert.deepEqual(state.entries, [first, second]);
  assert.deepEqual(moveNavigation(state, 1).target, undefined);
}

function fakeCommandRuntime(requireFullYes = false, statusGate?: Promise<void>): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot: "/tmp/project",
    sessionId: "session-1",
    sessionFile: "/tmp/project/.biny/sessions/session-1.jsonl",
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const context: ContextStatus = {
    loadedInstructions: [],
    instructionBytes: 0,
    instructionCapBytes: 10_000,
    snapshotRefreshedAt: undefined,
    snapshotDirty: false,
    repoMapRefreshedAt: undefined,
    repoMapDirty: false,
    repoMapEntries: 0,
    activePaths: [],
    recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: { maxTokens: 24_000, usedTokens: 10, omitted: [], autoCompacted: false, source: "estimated", measuredAt: undefined },
    memoryEnabled: false,
    memoryTopics: []
  };
  const request = {
    toolCallId: "tool-1",
    tool: "Write",
    title: "Allow write",
    details: "Write a file",
    requireFullYes,
    actionType: "write",
    riskLevel: "medium"
  };
  const agent = {
    getInfo: () => info,
    admitUserMessage: async () => undefined,
    getPermissionMode: () => "ask" as const,
    setPermissionMode: async () => undefined,
    listModels: () => [],
    switchModel: async () => ({ modelAlias: "test", provider: "test", modelLabel: "test/model", reasoningLabel: "Off", thinking: "off" as const }),
    async *prompt(input: string, options: AgentRunOptions): AsyncGenerator<AgentSessionEvent> {
      yield { type: "status", status: "thinking" };
      if (input === "status-snapshot") {
        yield { type: "status", status: "completed" };
        await statusGate;
        yield {
          type: "done",
          content: "done",
          outcome: {
            status: "completed",
            stopReason: "model_stop",
            finishReason: "stop",
            steps: 1,
            output: "done"
          }
        };
        return;
      }
      if (input === "terminal-blocked") {
        yield {
          type: "done",
          content: "",
          outcome: {
            status: "blocked",
            stopReason: "blocked",
            finishReason: "stop",
            steps: 1,
            output: "",
            error: "A deployment target is required.",
            resumable: true,
            blockedReason: "missing_user_input",
            requiredAction: "Choose staging or production."
          }
        };
        return;
      }
      if (input === "terminal-incomplete") {
        yield {
          type: "done",
          content: "",
          outcome: {
            status: "incomplete",
            stopReason: "hard_step_limit",
            finishReason: "tool-calls",
            steps: 96,
            output: "",
            error: "The hard step limit was reached.",
            resumable: true
          }
        };
        return;
      }
      if (input === "cancel") {
        if (!options.abortSignal?.aborted) {
          await new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        throw new Error("aborted");
      }
      if (input === "secret-event-error") {
        yield { type: "error", message: "provider token=opaque-live-run-secret" };
        return;
      }
      if (input === "secret-thrown-error") throw new Error("provider password=opaque-live-run-secret");
      const secretProbe = input === "secret";
      yield { type: "reasoning.started", phase: "initial" };
      if (secretProbe) {
        yield { type: "reasoning.delta", content: "token=opaque-live-tool-secret" };
      }
      yield { type: "reasoning.completed" };
      yield {
        type: "tool.started",
        toolCallId: "tool-1",
        tool: "Write",
        args: {
          path: "a.ts",
          apiKey: secretProbe ? "opaque-live-tool-secret" : undefined,
          webhookSecret: secretProbe ? "opaque-live-tool-secret" : undefined
        },
        display: {
          kind: "file_io",
          operation: "write",
          path: "a.ts",
          content: secretProbe ? "apiKey=opaque-live-tool-secret" : undefined
        }
      };
      await options.confirmPermission?.(request as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0]);
      const output = input === "stale"
        ? { status: "permission_required", approved: false, reason: "The target changed after approval." }
        : secretProbe
          ? { path: "a.ts", token: "opaque-live-tool-secret", diffPreview: "+ apiKey=opaque-live-tool-secret", safe: "visible" }
          : { path: "a.ts" };
      if (input === "stale") {
        yield {
          type: "tool.failed",
          toolCallId: "tool-1",
          tool: "Write",
          error: "The target changed after approval.",
          result: output
        };
      } else {
        yield { type: "tool.completed", toolCallId: "tool-1", tool: "Write", result: output };
      }
      yield { type: "assistant.delta", content: secretProbe ? "password=opaque-live-tool-secret" : "done" };
      const content = secretProbe ? "Authorization: Bearer opaque-live-tool-secret" : "done";
      yield { type: "assistant.completed", content };
      yield {
        type: "done",
        content,
        outcome: {
          status: "completed",
          stopReason: "model_stop",
          finishReason: "stop",
          steps: 1,
          output: content
        }
      };
    },
    contextStatus: async () => context,
    recordError: () => undefined,
    close: async () => undefined
  };
  return {
    agent,
    startSubagentTask: (task: string) => {
      const completion = task === "secret-subagent-failure"
        ? Promise.reject(new Error("subagent apiKey=opaque-live-run-secret"))
        : Promise.resolve(`subagent:${task}`);
      return { taskId: "desktop-test-subagent", completion };
    },
    subagents: undefined,
    refreshSkills: async () => undefined,
    setSubagentParentRunId: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function subscribeHostEvents(
  runtime: InteractiveAgentRuntime,
  listener: (event: AgentHostEvent) => void
): () => void {
  return runtime.subscribe((update) => {
    if (update.event) listener(update.event);
  });
}

function testDesktopComposerSlashItems(): void {
  const skill = (name: string, description: string): DesktopSkillCatalogEntry => ({
    name,
    description
  } as unknown as DesktopSkillCatalogEntry);
  const items = buildDesktopComposerItems([
    skill("zeta", "Zeta workflow"),
    skill("AI-slop", "Audit the interface"),
    skill("ai-SLOP", "Duplicate display name")
  ]);
  const commandItems = items.filter((item) => item.auxiliaryData?.kind === "command");
  const skillItems = items.filter((item) => item.auxiliaryData?.kind === "skill");

  assert.deepEqual(commandItems.map((item) => item.label), [
    "/compact",
    "/subagent",
    "/review",
    "/undo"
  ]);
  assert.equal(commandItems.some((item) => item.label === "/tasks"), false);
  assert.equal(commandItems.some((item) => item.label === "/status"), false);
  assert.equal(commandItems.every((item) => DESKTOP_COMPOSER_COMMAND_NAMES.includes(item.label as typeof DESKTOP_COMPOSER_COMMAND_NAMES[number])), true);
  assert.deepEqual(skillItems.map((item) => item.label), ["/skills:AI-slop", "/skills:zeta"]);
}

function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    persistent: true,
    get: async (account) => values.get(account),
    set: async (account, value) => {
      values.set(account, value);
    },
    delete: async (account) => {
      values.delete(account);
    }
  };
}
