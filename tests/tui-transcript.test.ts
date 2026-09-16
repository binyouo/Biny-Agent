import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createInitialTuiState, tuiReducer, type TuiAction } from "../src/tui/reducer.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";
import { formatSessionAge, formatToolDuration } from "../src/tui/transcriptText.js";
import { TranscriptView } from "../src/tui/components/transcriptView.js";
import { ActivitySummaryComponent, ThinkingComponent, ToolExecutionComponent, splitToolTitle } from "../src/tui/components/messages.js";
import { CardComponent, renderCardLines } from "../src/tui/components/cards.js";
import { PendingAttachmentsComponent, pendingAttachmentLabel } from "../src/tui/components/pendingAttachments.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "../src/tui/components/dialogs.js";
import {
  FooterComponent,
  ShortcutsBarComponent,
  StatusIndicatorComponent,
  WelcomeComponent,
  footerLayout,
  formatTokens,
  shortSessionId,
  shortcutHints,
  statusDivider,
  statusMessage,
  visibleShortcutHints
} from "../src/tui/components/chrome.js";
import {
  ctrlCAction,
  isDoubleCtrlC,
  memoryPolicyOptionForOverride,
  memoryPolicySelectOptions,
  runtimeStatus,
  selectDialogRow,
  shouldConfirmAutocompleteOnEnter,
  skillSlashCommandItems
} from "../src/tui/app.js";
import type { PermissionChoice, ToolTranscriptItem, TranscriptState, TuiPermissionRequest, TuiState } from "../src/tui/types.js";
import {
  ansi256ToHex,
  availableThemes,
  getTheme,
  rgbToAnsi256,
  setTheme,
  theme,
  themeBgTokens,
  themeColorTokens
} from "../src/tui/theme/index.js";
import { slashCommandsForSurface } from "../src/runtime/commandRegistry.js";
import { formatStatusReport } from "../src/runtime/statusReport.js";
import {
  buildMcpCard,
  buildSkillsCard,
  buildStatusCard,
  buildSubagentTasksCard,
  buildUsageCard
} from "../src/runtime/commandCards.js";
import type { CommandCardData } from "../src/runtime/commandCard.js";
import type { ExtensionStatus } from "../src/extensions/report.js";
import type { CardTranscriptItem } from "../src/tui/types.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { UsageSummary } from "../src/session/metadata.js";
import { activitySummaryText } from "../src/runtime/activitySummary.js";
import { modelThinkingOptions, selectedThinkingForModel } from "../src/tui/modelOptions.js";
import {
  confirmedPermissionChoice,
  createPermissionPromptInteractionState,
  permissionPromptStateForRequest
} from "../src/tui/permissionOptions.js";
import { isFullYesConfirmation, permissionResultFromAnswer } from "../src/permission/confirmation.js";
import { permissionChoiceToResult } from "../src/tui/runtime/permissionChoice.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { defaultChatPersonalizationOverride, resolveChatPersonalization } from "../src/personalization/index.js";

/** 去掉 ANSI，方便对渲染出来的行做文本断言。 */
function plain(line: string): string {
  return line.replace(/\u001B\[[0-9;]*m/g, "").replace(/\u001B_pi:c\u0007/g, "");
}

function plainLines(lines: string[]): string[] {
  return lines.map(plain);
}

const EVENT_BASE = {
  sessionId: "session",
  runId: "run",
  timestamp: "2026-07-24T00:00:00.000Z"
};

/** 测试事件统一补齐 AgentHostEvent 的公共字段，不再经过 TUI 私有适配层。 */
function reduce(state: TuiState, action: { type: string } & Record<string, unknown>): TuiState {
  return tuiReducer(state, { ...EVENT_BASE, ...action } as TuiAction);
}


/** 把一份 transcript 状态渲染成去掉 ANSI 的文本，便于断言。 */
function renderTranscript(transcript: TranscriptState, width: number): string {
  const view = new TranscriptView();
  view.sync(transcript);
  return renderView(view, width);
}

function renderView(view: TranscriptView, width: number): string {
  return plainLines(view.render(width)).join("\n");
}

async function main(): Promise<void> {
  testTranscriptUsesIndependentItemKinds();
  testReasoningStreamingRendersStatusOnly();
  testReasoningStepGroupsToolsAndShowsNextMarker();
  testLateReasoningDoesNotAppearBelowRunningTool();
  testIncompleteSessionStaysDistinctFromCompletion();
  testBlockedSessionShowsRequiredAction();
  testCancelledSessionStaysDistinctFromAbort();
  testAbortedSessionStaysDistinctFromCompletion();
  testAssistantStreamingUpdatesOneActiveCell();
  testToolProgressUpdatesOneActiveCell();
  testToolDurationMeasuredInUi();
  testActiveToolShowsLatestOutput();
  testParallelToolsUpdateById();
  testDuplicateCompletionDoesNotFinishSiblingTool();
  testReusedToolCallIdKeepsUniqueTranscriptCells();
  testRecoverableErrorDoesNotFinalizeSiblingTools();
  testPermissionRejectionKeepsTurnRunning();
  testMaintenanceDoesNotReuseTaskDuration();
  testMaintenanceKeepsStatusIndicatorIdle();
  testSelectDialogStaysNextToEditor();
  testPermissionConfirmationContract();
  testLongCommandKeepsDetailsHidden();
  testCommandDisplayNeverLeaksRawCommand();
  testFailedCommandCommitsOneToolItem();
  testErrorFinalizesActiveCells();
  testActivitySummaryBeforeTool();
  testActivitySummaryIsBoundedAndRedacted();
  testActivitySummaryUsesNormalTextColor();
  testSessionReplayUsesToolItems();
  testSessionReplayKeepsRemovedToolNames();
  testSessionReplayFinalizesPendingTools();
  testSessionReplayRestoresTurnStatuses();
  testSlashCommandParity();
  testPersonalizationSelectors();
  testStatusReportUsesRuntimeAndContextFields();
  testCommandCardCommitsTranscriptItem();
  testCommandCardRendersBoxedAlignedCard();
  testCardComponentTogglesDetailsLocally();
  testStatusAndUsageCardBuilders();
  testExtensionCardBuilders();
  testSkillSlashCommandItems();
  testSkillUserMessageHidesInstructions();
  testDoubleCtrlCGuard();
  testAutocompleteEnterOnlyConfirmsSkillSelection();
  await testSlashAutocompleteInsertsSingleSlash();
  testThemeTokensResolveToAnsi();
  testTranscriptViewSyncsIncrementally();
  testAssistantMarkdownRendersBlocks();
  testToolBlockRendersTitleAndClampedOutput();
  testThinkingBlockDefersStreamingBody();
  testFooterAndChromeLayout();
  testPendingAttachmentDisplay();
  testStatusAndShortcutHints();
  testWelcomeRendersOnboarding();
  testModelThinkingOptionsUseModelCapabilities();
  testDialogsRenderAndHandleKeys();
  testPermissionDialogRequiresFullYes();
  testTranscriptTextHelpers();
}

function testSkillSlashCommandItems(): void {
  assert.deepEqual(skillSlashCommandItems([
    { name: "zeta", description: "Zeta workflow" },
    { name: "ai-slop-taste", description: "Audit AI slop" },
    { name: "zeta", description: "Duplicate should be hidden" }
  ]), [
    { name: "skill:ai-slop-taste", description: "Audit AI slop" },
    { name: "skill:zeta", description: "Zeta workflow" }
  ]);
}

function testSkillUserMessageHidesInstructions(): void {
  const expanded = [
    '<skill name="ai-slop-taste" location="/Users/think/.cc-switch/skills/ai-slop-taste/SKILL.md">',
    "A long skill instruction that must stay out of the transcript.",
    "</skill>"
  ].join("\n");

  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: expanded });
  assert.equal(state.transcript.committed[0]?.content, "Skill: ai-slop-taste");
  assert.equal(renderTranscript(state.transcript, 80).includes("A long skill instruction"), false);

  const replayed = sessionEventsToTranscript([{ type: "user_message", content: expanded }]);
  assert.equal(replayed[0]?.content, "Skill: ai-slop-taste");

  const withTask = `${expanded}\n\naudit the settings page`;
  state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: withTask });
  assert.equal(state.transcript.committed[0]?.content, "Skill: ai-slop-taste\n\naudit the settings page");
  const rendered = renderTranscript(state.transcript, 80);
  assert.equal(rendered.includes("audit the settings page"), true);
  assert.equal(rendered.includes("A long skill instruction"), false);
  const replayedWithTask = sessionEventsToTranscript([{ type: "user_message", content: withTask }]);
  assert.equal(replayedWithTask[0]?.content, "Skill: ai-slop-taste\n\naudit the settings page");
}

function testDoubleCtrlCGuard(): void {
  assert.equal(isDoubleCtrlC(0, 100), false);
  assert.equal(isDoubleCtrlC(1_000, 1_499), true);
  assert.equal(isDoubleCtrlC(1_000, 1_500), false);
  assert.equal(isDoubleCtrlC(1_000, 1_501), false);
  assert.equal(ctrlCAction(0, 100), "cancel");
  assert.equal(ctrlCAction(1_000, 1_499), "exit");
  assert.equal(ctrlCAction(1_000, 1_500), "cancel");
}

function testAutocompleteEnterOnlyConfirmsSkillSelection(): void {
  assert.equal(shouldConfirmAutocompleteOnEnter("\r", true, "/skill:demo"), true);
  assert.equal(shouldConfirmAutocompleteOnEnter("\n", true, "/skill"), true);
  assert.equal(shouldConfirmAutocompleteOnEnter("\r", true, "/model"), false);
  assert.equal(shouldConfirmAutocompleteOnEnter("\r", false, "/skill:demo"), false);
  assert.equal(shouldConfirmAutocompleteOnEnter("\t", true, "/skill:demo"), false);
}

function testModelThinkingOptionsUseModelCapabilities(): void {
  const proOptions = modelThinkingOptions({ efforts: ["low", "medium", "high"], thinkingLevelMap: { off: "none" } });
  assert.deepEqual(proOptions.map((option) => option.value), ["off", "low", "medium", "high"]);
  assert.deepEqual(proOptions.map((option) => option.label), ["off", "low", "medium", "high"]);
  const lunaOptions = modelThinkingOptions({
    efforts: ["low", "medium", "high", "xhigh", "max"],
    thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
  });
  assert.deepEqual(lunaOptions.map((option) => option.label), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(lunaOptions.every((option) => Object.keys(option).length === 2), true);
  assert.deepEqual(modelThinkingOptions({ efforts: [], thinkingLevelMap: {} }), []);
  assert.equal(selectedThinkingForModel("deepseek", "off", { alias: "deepseek", defaultThinking: "high" }), "off");
  assert.equal(selectedThinkingForModel("deepseek", "high", { alias: "other", defaultThinking: "max" }), "max");
}

function testPermissionConfirmationContract(): void {
  assert.equal(isFullYesConfirmation("yes"), true);
  assert.equal(isFullYesConfirmation(" YES "), true);
  assert.equal(isFullYesConfirmation("y"), false);
  assert.equal(isFullYesConfirmation(""), false);

  const baseRequest = {
    tool: "Bash",
    title: "Command execution request",
    details: "sudo example",
    actionType: "shell",
    riskLevel: "critical",
    requireFullYes: true,
    command: "sudo example"
  };

  assert.deepEqual(permissionResultFromAnswer("", false), { approved: true, action: "allow_once", scope: "once", confirmation: undefined });
  assert.deepEqual(permissionResultFromAnswer("y", false), { approved: true, action: "allow_once", scope: "once", confirmation: undefined });
  assert.deepEqual(permissionResultFromAnswer("c", false), { approved: true, action: "allow_always", scope: "command", confirmation: undefined });
  assert.deepEqual(permissionResultFromAnswer("r Check the target", false), { approved: false, action: "deny_with_reason", scope: "once", message: "Check the target", confirmation: undefined });
  assert.equal(permissionResultFromAnswer("", true).approved, false);
  assert.equal(permissionResultFromAnswer("y", true).approved, false);
  assert.equal(permissionResultFromAnswer("c", true).approved, false);
  assert.deepEqual(permissionResultFromAnswer("yes", true), { approved: true, action: "allow_once", scope: "once", confirmation: "yes" });
  assert.deepEqual(permissionResultFromAnswer("YES   COMMAND", true), { approved: true, action: "allow_always", scope: "command", confirmation: "yes" });
  assert.deepEqual(permissionChoiceToResult("allow_once", { ...baseRequest, requireFullYes: false }), { approved: true, action: "allow_once", scope: "once", confirmation: undefined });
  assert.equal(permissionChoiceToResult("allow_once", baseRequest).confirmation, "yes");
  assert.equal(permissionChoiceToResult("allow_always", baseRequest).confirmation, "yes");
  assert.equal(permissionChoiceToResult("deny_with_reason", baseRequest, "not ready").message, "not ready");

  assert.equal(confirmedPermissionChoice(0, true, ""), "deny");
  assert.equal(confirmedPermissionChoice(1, true, ""), undefined);
  assert.equal(confirmedPermissionChoice(1, true, "", "not ready"), "deny_with_reason");
  assert.equal(confirmedPermissionChoice(2, true, ""), undefined);
  assert.equal(confirmedPermissionChoice(2, true, "yes"), "allow_once");
  assert.equal(confirmedPermissionChoice(3, true, "yes"), "allow_always");
  assert.equal(confirmedPermissionChoice(2, false, ""), "allow_once");

  const enteredState = {
    ...createPermissionPromptInteractionState(baseRequest),
    selectedIndex: 3,
    confirmation: "yes",
    confirmationAttempted: true
  };
  assert.equal(permissionPromptStateForRequest(enteredState, baseRequest), enteredState);
  assert.deepEqual(permissionPromptStateForRequest(enteredState, { ...baseRequest, title: "Next request" }), {
    request: { ...baseRequest, title: "Next request" },
    selectedIndex: 2,
    confirmation: "",
    confirmationAttempted: false,
    denialReason: "",
    denialReasonAttempted: false
  });

}

function testSlashCommandParity(): void {
  const tuiCommands = slashCommandsForSurface("tui");
  const desktopCommands = slashCommandsForSurface("desktop");
  const desktopNames = new Set(desktopCommands.map((command) => command.name));
  assert.equal(tuiCommands.length, 27);
  for (const removed of ["/help", "/approvals", "/quit"]) {
    assert.equal(tuiCommands.some((command) => command.name === removed), false);
  }
  assert.equal(tuiCommands.some((command) => command.name === "/plan"), false);
  assert.equal(tuiCommands.some((command) => command.name === "/mode"), false);
  assert.ok(tuiCommands.some((command) => command.name === "/memory"));
  assert.ok(tuiCommands.some((command) => command.name === "/soul"));
  assert.ok(tuiCommands.some((command) => command.name === "/memories"));
  assert.ok(tuiCommands.some((command) => command.name === "/undo"));
  assert.equal(tuiCommands.some((command) => command.name === "/continue"), false);
  assert.ok(tuiCommands.some((command) => command.name === "/fork"));
  assert.ok(tuiCommands.some((command) => command.name === "/new"));
  assert.ok(tuiCommands.some((command) => command.name === "/sessions"));
  assert.ok(tuiCommands.some((command) => command.name === "/worktree"));
  assert.ok(tuiCommands.some((command) => command.name === "/app"));
  assert.equal(desktopNames.has("/context"), false);
}

function testPersonalizationSelectors(): void {
  assert.deepEqual(memoryPolicySelectOptions.map((option) => option.value), ["inherit", "both", "use", "contribute", "off"]);
  const override = {
    ...defaultChatPersonalizationOverride,
    useMemories: false as const,
    contributeMemories: "inherit" as const
  };
  const resolved = resolveChatPersonalization(
    { enabled: true },
    {
      useMemories: true,
      contributeMemories: true,
      generateMemories: true,
      extractModel: undefined,
      excludeExternalContext: true,
      maxRecalled: 3
    },
    override
  );
  assert.equal(memoryPolicyOptionForOverride({ override, resolved }), "both");
}

function testStatusReportUsesRuntimeAndContextFields(): void {
  const info: AgentSessionInfo = {
    workspaceRoot: "/workspace",
    sessionId: "session-1",
    sessionFile: "/workspace/.biny/sessions/session-1.jsonl",
    provider: "deepseek",
    modelLabel: "deepseek-v4-pro",
    reasoningLabel: "Max",
    modelAlias: "deepseek-pro",
    thinking: "max"
  };
  const context: ContextStatus = {
    loadedInstructions: ["/workspace/AGENTS.md"],
    instructionBytes: 120,
    instructionCapBytes: 32_768,
    snapshotRefreshedAt: "2026-08-02T00:00:00.000Z",
    snapshotDirty: false,
    repoMapRefreshedAt: "2026-08-02T00:00:00.000Z",
    repoMapDirty: false,
    repoMapEntries: 12,
    activePaths: [],
    recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: {
      maxTokens: 981_056,
      usedTokens: 12_345,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      modelAlias: "deepseek-pro",
      estimatedTokens: 12_600,
      providerInputTokens: 12_345,
      omitted: [],
      autoCompacted: false,
      source: "provider",
      measuredAt: "2026-08-02T00:00:00.000Z"
    },
    memoryEnabled: true,
    memoryOverviewChars: 1_536
  };
  const usage: UsageSummary = {
    calls: 2,
    inputTokens: 20_000,
    outputTokens: 4_000,
    totalTokens: 24_000,
    reasoningTokens: 3_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: undefined,
    pricingKnown: false,
    pricedCalls: 0,
    unpricedCalls: 2
  };

  const report = formatStatusReport(info, "ask", context, usage, "Extensions\n\n(none)");
  assert.match(report, /Model: deepseek-v4-pro \(Max\)/u);
  assert.match(report, /Model provider: deepseek/u);
  assert.match(report, /Token usage: 24,000 total/u);
  assert.match(report, /Context window: 12,345 used \/ 1,000,000/u);
  assert.match(report, /Input budget: 12,345 \/ 981,056/u);
  assert.match(report, /Input measurement: estimated 12,600; provider 12,345; delta -255/u);
  assert.match(report, /Instructions: 1 loaded/u);
  assert.doesNotMatch(report, /^Context$/mu);
}

function testCommandCardCommitsTranscriptItem(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, {
    type: "command.card",
    command: "/status",
    title: "Status",
    data: { title: "Status", sections: [{ rows: [{ label: "Model", value: "test" }] }] }
  });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["card"]);
  const item = state.transcript.committed[0];
  assert.equal(item?.kind, "card");
  if (item?.kind !== "card") return;
  assert.equal(item.command, "/status");
  assert.equal(item.title, "Status");
  assert.equal(item.data.sections[0]?.rows[0]?.label, "Model");
}

function testCommandCardRendersBoxedAlignedCard(): void {
  const data: CommandCardData = {
    title: "Status",
    sections: [
      {
        rows: [
          { label: "Model", value: "gpt-5 (high)" },
          { label: "Provider", value: "openai" }
        ]
      },
      {
        rows: [
          { label: "Token usage", value: [{ tokens: 130_000, style: "bold" }, { text: " total " }, { text: "(120k input)", style: "dim" }] },
          { label: "Context window", value: [{ text: "23% left" }, { text: " (45k used / 200k)", style: "dim" }] },
          { label: "Compaction", value: "active; 5 messages compacted", detail: true }
        ]
      }
    ]
  };
  const item: CardTranscriptItem = { id: "card-1", kind: "card", command: "/status", title: "Status", data };

  const folded = plainLines(renderCardLines(item, false, 60)).join("\n");
  assert.match(folded, /^\/status$/mu);
  assert.match(folded, /^╭─ Status ─+╮$/mu);
  assert.match(folded, /^╰─+╯$/mu);
  assert.match(folded, /Model:\s+gpt-5 \(high\)/u);
  assert.match(folded, /23% left/u);
  // 折叠细节不显示，提示行报告剩余字段数
  assert.doesNotMatch(folded, /5 messages compacted/u);
  assert.match(folded, /1 more field · ctrl\+o to expand/u);

  const expanded = plainLines(renderCardLines(item, true, 60)).join("\n");
  assert.match(expanded, /5 messages compacted/u);
  assert.match(expanded, /ctrl\+o to collapse/u);
  // token 走紧凑格式化
  assert.match(expanded, /130k total/u);

  // 极窄终端退回 label: value 平铺（每行仍按宽度截断）
  const narrow = plainLines(renderCardLines(item, false, 8)).join("\n");
  assert.match(narrow, /^Model:/mu);
  assert.doesNotMatch(narrow, /╭─/u);
}

function testCardComponentTogglesDetailsLocally(): void {
  const view = new TranscriptView();
  let state = createInitialTuiState("/workspace");
  state = reduce(state, {
    type: "command.card",
    command: "/status",
    title: "Status",
    data: { title: "Status", sections: [{ rows: [{ label: "Detail", value: "secret detail", detail: true }] }] }
  });
  view.sync(state.transcript);
  const component = view.componentFor(state.transcript.committed[0]?.id ?? "");
  assert.ok(component instanceof CardComponent);
  const before = renderView(view, 60);
  assert.doesNotMatch(before, /secret detail/u);
  if (!(component instanceof CardComponent)) return;
  component.toggleDetails();
  const after = renderView(view, 60);
  assert.match(after, /secret detail/u);
  component.toggleDetails();
  assert.doesNotMatch(renderView(view, 60), /secret detail/u);
}

function testStatusAndUsageCardBuilders(): void {
  const info: AgentSessionInfo = {
    workspaceRoot: "/workspace",
    sessionId: "session-1",
    sessionFile: "/workspace/.biny/sessions/session-1.jsonl",
    provider: "deepseek",
    modelLabel: "deepseek-v4-pro",
    reasoningLabel: "Max",
    modelAlias: "deepseek-pro",
    thinking: "max"
  };
  const context: ContextStatus = {
    loadedInstructions: ["/workspace/AGENTS.md"],
    instructionBytes: 120,
    instructionCapBytes: 32_768,
    snapshotRefreshedAt: undefined,
    snapshotDirty: false,
    repoMapRefreshedAt: undefined,
    repoMapDirty: false,
    repoMapEntries: 12,
    activePaths: [],
    recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: {
      maxTokens: 981_056,
      usedTokens: 12_345,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      modelAlias: "deepseek-pro",
      estimatedTokens: 12_600,
      providerInputTokens: 12_345,
      omitted: [],
      autoCompacted: false,
      source: "provider",
      measuredAt: undefined
    },
    memoryEnabled: false,
    memoryTopics: []
  };
  const usage: UsageSummary = {
    calls: 2,
    inputTokens: 20_000,
    outputTokens: 4_000,
    totalTokens: 24_000,
    reasoningTokens: 3_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0.0123,
    pricingKnown: true,
    pricedCalls: 2,
    unpricedCalls: 0,
    latestCacheHitRate: 0.85,
    sessionCacheHitRate: 0.9,
    epochCacheHitRates: { "epoch-1": 0.5, "epoch-2": null }
  };
  const extensions: ExtensionStatus = {
    mcp: [],
    skills: [],
    skillWarnings: [],
    plugins: [],
    subagent: {
      enabled: true,
      maxSteps: 8,
      maxOutputTokens: 32_768,
      maxConcurrentSubagents: 2,
      maxPendingSubagents: 4,
      timeoutMs: 600_000,
      allowedTools: ["Read"],
      agents: []
    },
    toolScheduling: { maxConcurrentTools: 1, maxQueuedToolCalls: 4 },
    toolCounts: { builtin: 4, mcp: 0, skill: 0, plugin: 0, subagent: 1 }
  };

  const card = buildStatusCard(info, "ask", context, usage, extensions, {
    calls: 3,
    succeeded: 2,
    failed: 1,
    totalAttempts: 4,
    retries: 1,
    totalDurationMs: 12_000
  });
  const rows = card.sections.flatMap((section) => section.rows);
  assert.ok(rows.some((row) => row.label === "Model" && row.value === "deepseek-v4-pro (Max)" && !row.detail));
  assert.ok(rows.some((row) => row.label === "Session" && row.tone === "dim"));
  const tokenRow = rows.find((row) => row.label === "Token usage");
  assert.ok(tokenRow && !tokenRow.detail);
  const windowRow = rows.find((row) => row.label === "Context window");
  assert.ok(windowRow && Array.isArray(windowRow.value));
  const windowFirst = windowRow.value[0];
  assert.ok(windowFirst && typeof windowFirst === "object" && "text" in windowFirst);
  assert.match(windowFirst.text, /% left/u);
  // 余量充足时百分比无强调色
  assert.equal(windowFirst.style, undefined);
  assert.ok(rows.some((row) => row.label === "Compaction" && row.detail));
  assert.ok(rows.some((row) => row.label === "Instructions" && row.detail));
  assert.ok(rows.some((row) => row.label === "MCP" && !row.detail));
  assert.ok(rows.some((row) => row.label === "Subagent" && !row.detail));

  // 上下文余量不足时窗口百分比标 warning / error
  const lowContext = { ...context, budget: { ...context.budget, usedTokens: 990_000 } };
  const lowCard = buildStatusCard(info, "ask", lowContext, usage, extensions);
  const lowWindow = lowCard.sections.flatMap((section) => section.rows).find((row) => row.label === "Context window");
  assert.ok(lowWindow && Array.isArray(lowWindow.value));
  const lowFirst = lowWindow.value[0];
  assert.ok(lowFirst && typeof lowFirst === "object" && "text" in lowFirst);
  assert.match(lowFirst.text, /1% left/u);
  assert.equal(lowFirst.style, "error");

  const usageCard = buildUsageCard(usage);
  const usageRows = usageCard.sections.flatMap((section) => section.rows);
  const total = usageRows.find((row) => row.label === "Total tokens");
  assert.ok(total && typeof total.value === "object" && !Array.isArray(total.value) && "tokens" in total.value);
  assert.equal(total.value.tokens, 24_000);
  assert.equal(total.value.style, "bold");
  const cost = usageRows.find((row) => row.label === "Cost");
  assert.deepEqual(cost?.value, { text: "$0.0123", style: "success" });
  assert.ok(usageRows.some((row) => row.label === "Epoch" && row.detail));
  assert.ok(usageRows.some((row) => row.label === "Cache hit" && !row.detail));

  const emptyUsage = buildUsageCard({ ...usage, calls: 0 });
  assert.match(String(emptyUsage.sections[0]?.rows[0]?.value), /no model calls recorded/u);
}

function testExtensionCardBuilders(): void {
  const mcpCard = buildMcpCard([
    {
      name: "fs",
      command: "npx",
      transport: "stdio",
      enabled: true,
      connected: true,
      toolNames: ["read", "write"],
      promptNames: [],
      hasResources: false
    },
    { name: "legacy", command: "bin", transport: "stdio", enabled: true, connected: false, toolNames: [], promptNames: [], hasResources: false, lastError: "timeout" }
  ]);
  const mcpRows = mcpCard.sections[0]?.rows ?? [];
  assert.equal(mcpRows[0]?.label, "fs");
  assert.equal(mcpRows[0]?.tone, "success");
  assert.equal(mcpRows[1]?.tone, "warning");
  assert.ok(mcpRows.some((row) => row.detail && row.label === ""));

  const skillsCard = buildSkillsCard([{ name: "zeta" }, { name: "ai-slop" }], ["duplicate skill: alpha"]);
  const skillsRows = skillsCard.sections[0]?.rows ?? [];
  assert.match(String(skillsRows[0]?.value), /2 loaded: ai-slop, zeta/u);
  const warning = skillsRows.find((row) => row.detail);
  assert.ok(warning && typeof warning.value === "object" && !Array.isArray(warning.value) && "text" in warning.value);
  assert.equal(warning.value.style, "warning");

  const subagentCard = buildSubagentTasksCard([
    {
      taskId: "task-1",
      parentRunId: "parent-1",
      task: "inspect the build output",
      status: "completed",
      createdAt: "2026-07-18T00:00:00.000Z",
      deadline: "2026-07-18T00:02:00.000Z"
    }
  ]);
  const subagentRows = subagentCard.sections[0]?.rows ?? [];
  assert.equal(subagentRows[0]?.label, "task-1");
  assert.equal(subagentRows[0]?.tone, "success");
  assert.ok(subagentRows.slice(1).every((row) => row.detail));

  const empty = buildMcpCard([]);
  assert.match(String(empty.sections[0]?.rows[0]?.value), /no servers configured/u);
}

function testTranscriptUsesIndependentItemKinds(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "question" });
  state = reduce(state, { type: "assistant.completed", content: "answer" });
  state = reduce(state, { type: "system.message", content: "notification" });
  state = reduce(state, { type: "run.failed", durationMs: 10, error: "fatal" });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["user", "assistant", "notification", "error"]);

  state = reduce(state, { type: "tool.started", toolCallId: "read-1", tool: "Read", args: { path: "README.md" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "read-1", tool: "Read", result: { path: "README.md", content: "hello" } });
  assert.equal(state.transcript.committed.at(-1)?.kind, "tool");
}

function testReasoningStreamingRendersStatusOnly(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "inspect" });
  state = reduce(state, { type: "reasoning.delta", content: "先检查" });
  state = reduce(state, { type: "reasoning.delta", content: "入口文件。" });
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["reasoning"]);
  assert.equal(state.transcript.active[0]?.content, "");

  const streamingView = new TranscriptView();
  streamingView.sync(state.transcript);
  const streamingThinking = renderView(streamingView, 80);
  assert.match(streamingThinking, /✶ Thinking…/u);
  assert.doesNotMatch(streamingThinking, /先检查入口文件。/u);

  state = reduce(state, { type: "reasoning.completed" });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["user", "reasoning"]);
  assert.equal(state.transcript.committed[1]?.content, "");
  // 实时 reasoning 不写进 TUI；session 恢复时仍可带回历史正文。
  const view = new TranscriptView();
  view.sync(state.transcript);
  const visibleThinking = renderView(view, 80);
  assert.match(visibleThinking, /Thought for/u);
  assert.doesNotMatch(visibleThinking, /先检查入口文件。/u);

  state = reduce(state, { type: "reasoning.delta", content: "继续验证。" });
  assert.equal(state.transcript.active.at(-1)?.content, "");
}

function testLateReasoningDoesNotAppearBelowRunningTool(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "reasoning.delta", content: "先检查入口。" });
  state = reduce(state, { type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "src/index.ts" } });
  state = reduce(state, { type: "reasoning.delta", content: "继续确认相关调用。" });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["reasoning"]);
  assert.equal(state.transcript.committed[0]?.content, "");
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["tool"]);
  const view = new TranscriptView();
  view.sync(state.transcript);
  const reasoning = view.componentFor(state.transcript.committed[0]?.id ?? "");
  assert.ok(reasoning instanceof ThinkingComponent);
  const output = renderView(view, 80);
  assert.doesNotMatch(output, /继续确认相关调用。/u);
}

function testReasoningStepGroupsToolsAndShowsNextMarker(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "reasoning.started", phase: "initial" });
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["reasoning"]);
  state = reduce(state, { type: "reasoning.delta", content: "先定位入口。" });
  state = reduce(state, { type: "tool.started", toolCallId: "read-1", tool: "Read", args: { path: "src/index.ts" } });
  state = reduce(state, { type: "tool.started", toolCallId: "read-2", tool: "Read", args: { path: "src/app.ts" } });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["reasoning"]);
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["tool", "tool"]);

  state = reduce(state, { type: "tool.completed", toolCallId: "read-1", tool: "Read", result: { content: "one" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "read-2", tool: "Read", result: { content: "two" } });
  state = reduce(state, { type: "reasoning.started", phase: "continuing" });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["reasoning", "tool", "tool"]);
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["reasoning"]);
  const view = new TranscriptView();
  view.sync(state.transcript);
  const output = renderView(view, 100);
  assert.match(output, /Thought for/u);
  assert.match(output, /Thinking…/u);
  assert.equal(output.indexOf("Thought for") < output.indexOf("Read"), true);
  assert.equal(output.indexOf("Read") < output.lastIndexOf("Thinking…"), true);
}

function testIncompleteSessionStaysDistinctFromCompletion(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "finish the project" });
  state = reduce(state, {
    type: "run.incomplete",
    durationMs: 10,
    reason: "Step limit reached.",
    stopReason: "step_limit",
    steps: 1
  });
  assert.equal(state.transcript.committed.at(-1)?.kind, "notification");
  assert.match(state.transcript.committed.at(-1)?.content ?? "", /Step limit/);
}

function testBlockedSessionShowsRequiredAction(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "finish the project" });
  state = reduce(state, {
    type: "run.blocked",
    durationMs: 10,
    reason: "missing_user_input",
    summary: "The target environment is unknown.",
    requiredAction: "Choose staging or production."
  });
  const notification = state.transcript.committed.at(-1);
  assert.equal(notification?.kind, "notification");
  assert.equal(notification?.kind === "notification" ? notification.tone : undefined, "warning");
  assert.match(notification?.content ?? "", /target environment/u);
  assert.match(notification?.content ?? "", /Choose staging or production/u);
}

function testCancelledSessionStaysDistinctFromAbort(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "run the project" });
  state = reduce(state, { type: "run.cancelled", durationMs: 10, reason: "Cancelled by user." });
  assert.equal(state.transcript.committed.at(-1)?.kind, "notification");
  assert.match(state.transcript.committed.at(-1)?.content ?? "", /cancelled by user/i);
}

function testAbortedSessionStaysDistinctFromCompletion(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "run the project" });
  state = reduce(state, { type: "run.aborted", durationMs: 10, reason: "Current turn interrupted." });
  assert.equal(state.transcript.committed.at(-1)?.kind, "notification");
  assert.match(state.transcript.committed.at(-1)?.content ?? "", /interrupted/i);
}

function testAssistantStreamingUpdatesOneActiveCell(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "stream" });
  const committedBefore = state.transcript.committed.length;
  state = reduce(state, { type: "assistant.delta", content: "你" });
  const activeId = state.transcript.active[0]?.id;
  state = reduce(state, { type: "assistant.delta", content: "好" });
  state = reduce(state, { type: "assistant.delta", content: "！" });

  assert.equal(state.transcript.committed.length, committedBefore);
  assert.equal(state.transcript.active.length, 1);
  assert.equal(state.transcript.active[0]?.id, activeId);
  assert.deepEqual(state.transcript.active[0], { id: activeId, kind: "assistant", content: "你好！" });

  state = reduce(state, { type: "assistant.completed", content: "你好！" });
  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.filter((item) => item.kind === "assistant").length, 1);
}

function testToolProgressUpdatesOneActiveCell(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "run-1", tool: "Bash", args: { command: "printf hello" } });
  state = reduce(state, { type: "tool.progress", toolCallId: "run-1", tool: "Bash", update: { kind: "status", text: "Started: printf hello" } });
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, "Running…");
  state = reduce(state, { type: "tool.progress", toolCallId: "run-1", tool: "Bash", update: { kind: "stdout", text: "hel" } });
  state = reduce(state, { type: "tool.progress", toolCallId: "run-1", tool: "Bash", update: { kind: "stdout", text: "lo" } });

  assert.equal(state.transcript.committed.length, 0);
  assert.equal(state.transcript.active.length, 1);
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).output, "hello");

  state = reduce(state, {
    type: "tool.completed",
    toolCallId: "run-1",
    tool: "Bash",
    result: { stdout: "hello", stderr: "", exitCode: 0, durationMs: 12 }
  });
  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.length, 1);
  assert.equal(state.transcript.committed[0]?.kind, "tool");
}

function testToolDurationMeasuredInUi(): void {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let state = createInitialTuiState("/workspace");
    state = reduce(state, { type: "tool.started", toolCallId: "timed", tool: "Read", args: { path: "README.md" } });
    now = 2_450;
    state = reduce(state, { type: "tool.completed", toolCallId: "timed", tool: "Read", result: { content: "done" } });
    assert.equal((state.transcript.committed[0] as ToolTranscriptItem).durationMs, 1_450);
  } finally {
    Date.now = originalNow;
  }
}

function testActiveToolShowsLatestOutput(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "streaming", tool: "Bash", args: { command: "long-running-command" } });
  state = reduce(state, {
    type: "tool.progress",
    toolCallId: "streaming",
    tool: "Bash",
    update: { kind: "stdout", text: Array.from({ length: 8 }, (_, index) => `line ${String(index + 1)}`).join("\n") }
  });
  // 运行中的工具默认只显示标题；原始 stdout 不进入主 transcript。
  const view = new TranscriptView();
  view.sync(state.transcript);
  const compact = renderView(view, 80);
  assert.doesNotMatch(compact, /line 8/u);
  assert.doesNotMatch(compact, /earlier lines/u);
}

function testParallelToolsUpdateById(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "one", tool: "Read", args: { path: "one.ts" } });
  state = reduce(state, { type: "tool.started", toolCallId: "two", tool: "Read", args: { path: "two.ts" } });
  state = reduce(state, { type: "tool.progress", toolCallId: "two", tool: "Read", update: { kind: "progress", text: "second" } });
  assert.equal((state.transcript.active[1] as ToolTranscriptItem).progress, "second");
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, undefined);

  state = reduce(state, { type: "tool.completed", toolCallId: "one", tool: "Read", result: { path: "one.ts", content: "one" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "two", tool: "Read", result: { path: "two.ts", content: "two" } });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["one", "two"]);
  assert.equal(new Set(state.transcript.committed.map((item) => item.id)).size, 2);
  assert.equal(state.transcript.active.length, 0);
}

function testDuplicateCompletionDoesNotFinishSiblingTool(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "one", tool: "Read", args: { path: "one.ts" } });
  state = reduce(state, { type: "tool.started", toolCallId: "two", tool: "Read", args: { path: "two.ts" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "one", tool: "Read", result: { content: "one" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "one", tool: "Read", result: { content: "duplicate" } });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["one"]);
  assert.deepEqual(state.transcript.active.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["two"]);
}

function testReusedToolCallIdKeepsUniqueTranscriptCells(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "tool-1-1", tool: "Read", args: { path: "one.ts" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "tool-1-1", tool: "Read", result: { content: "one" } });
  const firstId = state.transcript.committed[0]?.id;
  state = reduce(state, { type: "tool.started", toolCallId: "tool-1-1", tool: "Read", args: { path: "two.ts" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "tool-1-1", tool: "Read", result: { content: "two" } });

  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.filter((item) => item.kind === "tool").length, 2);
  assert.notEqual(state.transcript.committed[1]?.id, firstId);
}

function testRecoverableErrorDoesNotFinalizeSiblingTools(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "failed", tool: "Bash", args: { command: "false" } });
  state = reduce(state, { type: "tool.started", toolCallId: "success", tool: "Bash", args: { command: "true" } });
  state = reduce(state, { type: "tool.completed", toolCallId: "failed", tool: "Bash", result: { stderr: "failed", exitCode: 1 } });
  state = reduce(state, { type: "error.message", message: "first command failed" });

  assert.deepEqual(state.transcript.active.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["success"]);
  state = reduce(state, { type: "tool.completed", toolCallId: "success", tool: "Bash", result: { stdout: "ok", exitCode: 0 } });
  const tools = state.transcript.committed.filter((item): item is ToolTranscriptItem => item.kind === "tool");
  assert.deepEqual(tools.map((item) => item.status), ["failed", "success"]);
  assert.equal(state.transcript.committed.some((item) => item.kind === "error"), true);
}

function testPermissionRejectionKeepsTurnRunning(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "write it" });
  state = reduce(state, { type: "tool.started", toolCallId: "write", tool: "Write", args: { path: "x.ts" } });
  state = reduce(state, {
    type: "permission.requested",
    requestId: "permission",
    toolCallId: "write",
    request: {
      toolCallId: "write",
      tool: "Write",
      title: "Write x.ts",
      details: "write",
      requireFullYes: false,
      actionType: "write",
      riskLevel: "write"
    }
  });
  const turnStartedAt = state.turnStartedAt;
  state = reduce(state, {
    type: "permission.resolved",
    requestId: "permission",
    toolCallId: "write",
    tool: "Write",
    approved: false,
    message: "Denied"
  });
  assert.equal(state.turnStartedAt, turnStartedAt);
  assert.equal(state.transcript.active.length, 1);
}

function testMaintenanceDoesNotReuseTaskDuration(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "message.user", content: "run the task" });
  state = reduce(state, {
    type: "run.completed",
    durationMs: 138,
    stopReason: "model_stop",
    steps: 1
  });
  assert.equal(state.lastWorkedMs !== undefined, true);

  state = reduce(state, { type: "maintenance.started" });
  assert.equal(state.turnStartedAt, undefined);
  assert.equal(state.lastWorkedMs, undefined);
}

function testMaintenanceKeepsStatusIndicatorIdle(): void {
  const maintenanceSnapshot = {
    state: { kind: "maintenance", operation: "switch_model" }
  } as unknown as InteractiveRuntimeSnapshot;
  assert.equal(runtimeStatus(maintenanceSnapshot), "idle");

  const status = new StatusIndicatorComponent({ requestRender: () => undefined } as unknown as TUI);
  status.setState("running", Date.now() - 80);
  status.setState("idle");
  assert.deepEqual(plainLines(status.render(50)), [""]);

  status.setState("idle", undefined, 80);
  assert.match(plainLines(status.render(50))[0] ?? "", /Worked for 80ms/u);
  status.dispose();
}

function testSelectDialogStaysNextToEditor(): void {
  // 主内容不足一屏时，选择器紧接输入框，不锚定到终端底部。
  assert.equal(selectDialogRow(13, 5, 50, 3), 10);
  // 内容或列表过长时不能超出可见视口。
  assert.equal(selectDialogRow(50, 8, 20, 3), 12);
}

function testLongCommandKeepsDetailsHidden(): void {
  const command = `node script.js ${"--very-long-option ".repeat(20)}`;
  let state = createInitialTuiState("/workspace");
  state = reduce(state, {
    type: "tool.started",
    toolCallId: "long-command",
    tool: "Bash",
    args: { command },
    display: { kind: "command", command }
  });
  const active = state.transcript.active[0] as ToolTranscriptItem;
  assert.equal(active.title, "Running command");
  assert.equal(active.title.includes(command), false);
  assert.match(active.details ?? "", /Command: node script\.js/);
  assert.match(active.details ?? "", /Exit code: running/);

  state = reduce(state, {
    type: "tool.completed",
    toolCallId: "long-command",
    tool: "Bash",
    result: { stdout: "done", stderr: "", exitCode: 0, durationMs: 25 }
  });
  const tool = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(tool.title, "Ran command");
  assert.match(tool.details ?? "", /Command: node script\.js/);
  assert.match(tool.details ?? "", /Exit code: 0/);

  const view = new TranscriptView();
  view.sync(state.transcript);
  const rendered = renderView(view, 40);
  assert.equal(rendered.includes(command), false);
  assert.equal(rendered.includes("Command: node script.js"), false);
  assert.equal(rendered.includes("Exit code"), false);
}

function testCommandDisplayNeverLeaksRawCommand(): void {
  const command = "pnpm test --filter private-package-name";
  let state = createInitialTuiState("/workspace");
  state = reduce(state, {
    type: "tool.started",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    args: { script: command },
    description: `Run ${command}`,
    display: { kind: "command", command }
  });
  const active = state.transcript.active[0] as ToolTranscriptItem;
  assert.equal(active.title, "Running tests");
  assert.equal(active.title.includes(command), false);
  assert.match(active.details ?? "", /Command: pnpm test/);
  state = reduce(state, {
    type: "tool.progress",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    update: { kind: "progress", text: `Executing ${command}` }
  });
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, "Running…");
  state = reduce(state, {
    type: "tool.completed",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    result: { stdout: "passed", exitCode: 0 }
  });
  const completed = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(completed.title, "Ran tests");
  assert.match(completed.details ?? "", /Exit code: 0/);
}

function testFailedCommandCommitsOneToolItem(): void {
  const command = "pnpm test --filter impossible";
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "tool.started", toolCallId: "failed", tool: "Bash", args: { command } });
  state = reduce(state, {
    type: "tool.completed",
    toolCallId: "failed",
    tool: "Bash",
    result: { stdout: "partial output", stderr: "test suite failed", exitCode: 2, durationMs: 7 }
  });
  assert.equal(state.transcript.committed.length, 1);
  const tool = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(tool.status, "failed");
  assert.equal(tool.title, "Ran tests");
  const collapsed = renderTranscript(state.transcript, 80);
  assert.match(collapsed, /test suite failed/);
  assert.equal(collapsed.includes(command), false);
  assert.equal(collapsed.includes("Exit code: 2"), false);
  assert.match(tool.details ?? "", /Exit code: 2/);
  assert.match(tool.details ?? "", /partial output/);
}

function testErrorFinalizesActiveCells(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "assistant.delta", content: "partial" });
  state = reduce(state, { type: "tool.started", toolCallId: "broken", tool: "Bash", args: { command: "bad-command" } });
  state = reduce(state, { type: "run.failed", durationMs: 10, error: "spawn failed" });
  assert.equal(state.transcript.active.length, 0);
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["activity", "tool", "error"]);
  const activity = state.transcript.committed[0];
  assert.equal(activity?.kind === "activity" ? activity.content : undefined, "partial");
  const tool = state.transcript.committed[1] as ToolTranscriptItem;
  assert.equal(tool.status, "failed");
  assert.match(tool.details ?? "", /spawn failed/);
}

function testActivitySummaryBeforeTool(): void {
  let state = createInitialTuiState("/workspace");
  state = reduce(state, { type: "assistant.delta", content: "先读取入口文件，再确认调用关系。" });
  state = reduce(state, { type: "tool.started", toolCallId: "read", tool: "Read", args: { path: "src/index.ts" } });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["activity"]);
  assert.equal(state.transcript.committed[0]?.kind === "activity" ? state.transcript.committed[0].content : undefined, "先读取入口文件，再确认调用关系。");
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["tool"]);
  const output = renderTranscript(state.transcript, 80);
  assert.match(output, /先读取入口文件，再确认调用关系。/u);
  assert.doesNotMatch(output, /assistant/u);
}

function testActivitySummaryIsBoundedAndRedacted(): void {
  const summary = activitySummaryText(`token=opaque-live-tool-secret ${"x".repeat(300)}`);
  assert.match(summary, /token=\[redacted\]/u);
  assert.equal(summary.length, 240);
  assert.match(summary, /…$/u);
}

function testActivitySummaryUsesNormalTextColor(): void {
  setTheme("dark");
  const content = "先读取入口文件。";
  const component = new ActivitySummaryComponent({ id: "activity-1", kind: "activity", content });
  const rendered = component.render(80).join("\n");
  assert.equal(rendered.includes(theme.fg("text", content)), true);
  assert.equal(rendered.includes("›"), false);
  assert.equal(rendered.includes(theme.fg("muted", content)), false);
}

function testSessionReplayUsesToolItems(): void {
  const items = sessionEventsToTranscript([
    { type: "user_message", content: "read", time: "2026-07-12T00:00:00.000Z" },
    { type: "tool_call", toolCallId: "read-1", tool: "Read", args: { path: "README.md" }, assistantContent: "先读取 README。", reasoningContent: "原始思考不应进入主界面。", time: "2026-07-12T00:00:01.000Z" },
    { type: "tool_result", toolCallId: "read-1", tool: "Read", result: { path: "README.md", content: "line 1\nline 2" }, time: "2026-07-12T00:00:03.500Z" },
    { type: "assistant_message", content: "done" }
  ] as SessionEvent[]);
  assert.deepEqual(items.map((item) => item.kind), ["user", "activity", "tool", "assistant"]);
  assert.equal(items[1]?.content, "先读取 README。");
  assert.equal(items.some((item) => item.kind !== "tool" && item.content.includes("原始思考")), false);
  const tool = items[2] as ToolTranscriptItem;
  assert.equal(tool.title, "Read README.md");
  assert.equal(tool.output, "line 1\nline 2");
  assert.equal(tool.durationMs, 2_500);
}

function testSessionReplayKeepsRemovedToolNames(): void {
  const items = sessionEventsToTranscript([
    { type: "tool_call", toolCallId: "legacy", tool: "apply_patch", args: { path: "README.md", patch: "@@ -1 +1 @@" } },
    { type: "tool_result", toolCallId: "legacy", tool: "apply_patch", result: { path: "README.md", status: "completed" } }
  ] as SessionEvent[]);
  const tool = items[0] as ToolTranscriptItem;
  assert.equal(tool.title, "Ran apply patch");
}

function testSessionReplayFinalizesPendingTools(): void {
  const failed = sessionEventsToTranscript([
    { type: "tool_call", toolCallId: "failed", tool: "Bash", args: { command: "false" } },
    { type: "error", message: "process failed" }
  ] as SessionEvent[]);
  assert.deepEqual(failed.map((item) => item.kind), ["tool", "error"]);
  assert.equal((failed[0] as ToolTranscriptItem).status, "failed");

  const interrupted = sessionEventsToTranscript([
    { type: "tool_call", toolCallId: "pending", tool: "Bash", args: { command: "sleep 10" } }
  ] as SessionEvent[]);
  assert.equal((interrupted[0] as ToolTranscriptItem).status, "skipped");
  assert.equal((interrupted[0] as ToolTranscriptItem).title, "Skipped command");
}

function testSessionReplayRestoresTurnStatuses(): void {
  const blocked = sessionEventsToTranscript([
    { type: "user_message", content: "deploy" },
    { type: "assistant_message", content: "Need a target." },
    {
      type: "turn_status",
      status: "blocked",
      stopReason: "blocked",
      steps: 1,
      summary: "The target environment is unknown.",
      resumable: true,
      blockedReason: "missing_user_input",
      requiredAction: "Choose staging or production."
    }
  ] as SessionEvent[]);
  const blockedStatus = blocked.at(-1);
  assert.equal(blockedStatus?.kind, "notification");
  assert.equal(blockedStatus?.kind === "notification" ? blockedStatus.tone : undefined, "warning");
  assert.match(blockedStatus?.content ?? "", /Choose staging or production/u);
  assert.match(blockedStatus?.content ?? "", /Send a new message to continue this task/u);

  const failed = sessionEventsToTranscript([
    { type: "user_message", content: "run" },
    { type: "error", message: "provider failed" },
    {
      type: "turn_status",
      status: "failed",
      stopReason: "provider_error",
      steps: 1,
      summary: "The provider failed."
    }
  ] as SessionEvent[]);
  assert.deepEqual(failed.map((item) => item.kind), ["user", "error"]);
  assert.equal(failed.at(-1)?.content, "The provider failed.");

  const completed = sessionEventsToTranscript([
    { type: "user_message", content: "answer" },
    { type: "assistant_message", content: "done" },
    {
      type: "turn_status",
      status: "completed",
      stopReason: "model_stop",
      steps: 1
    }
  ] as SessionEvent[]);
  assert.deepEqual(completed.map((item) => item.kind), ["user", "assistant"]);
}

function testThemeTokensResolveToAnsi(): void {
  const tokens = [...themeColorTokens, ...themeBgTokens];
  for (const name of availableThemes()) {
    setTheme(name);
    for (const token of tokens) {
      assert.match(getTheme().color(token), /^#[0-9a-f]{6}$/, `${name} 主题缺少 token ${token}`);
    }
  }

  setTheme("dark");
  const dark = getTheme().color("accent");
  setTheme("light");
  assert.notEqual(getTheme().color("accent"), dark);
  setTheme("does-not-exist");
  assert.equal(getTheme().color("accent"), dark);

  // 前景只重置前景，保证嵌套加粗不会把颜色清掉。
  const nested = theme.fg("accent", `a${theme.bold("b")}c`);
  assert.match(nested, /\u001B\[39m$/u);
  assert.equal(plain(nested), "abc");
  assert.equal(plain(theme.bg("userMessageBg", "x")), "x");

  // 思考等级越高边框越亮，未知等级退回 off。
  assert.equal(plain(theme.thinkingBorder("max")("│")), "│");
  assert.notEqual(theme.thinkingBorder("max")("│"), theme.thinkingBorder("off")("│"));
  assert.equal(theme.thinkingBorder(undefined)("│"), theme.thinkingBorder("off")("│"));

  assert.equal(ansi256ToHex(196), "#ff0000");
  assert.equal(ansi256ToHex(240), "#585858");
  assert.equal(rgbToAnsi256(255, 0, 0), 196);
}

function testTranscriptViewSyncsIncrementally(): void {
  setTheme("dark");
  const view = new TranscriptView();
  const user = { id: "u1", kind: "user" as const, content: "请分析 `src/`" };
  const assistant = { id: "a1", kind: "assistant" as const, content: "## 结论\n\n- 一\n- 二" };

  assert.equal(view.sync({ committed: [user], active: [] }), true);
  const first = view.componentFor("u1");
  assert.notEqual(first, undefined);

  // 同一批条目再同步一次不应重建组件，也不应报告变化。
  assert.equal(view.sync({ committed: [user], active: [] }), false);
  assert.equal(view.componentFor("u1"), first);

  assert.equal(view.sync({ committed: [user], active: [assistant] }), true);
  const lines = plainLines(view.render(40));
  assert.match(lines.join("\n"), /请分析 src\//u);
  assert.match(lines.join("\n"), /结论/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, line);

  // 条目消失后组件要被回收。
  assert.equal(view.sync({ committed: [user], active: [] }), true);
  assert.equal(view.componentFor("a1"), undefined);
}

function testAssistantMarkdownRendersBlocks(): void {
  setTheme("dark");
  const view = new TranscriptView();
  view.sync({
    committed: [{
      id: "a1",
      kind: "assistant" as const,
      content: "## 标题\n\n| 模式 | 数 |\n|---|---|\n| apiKey | 0 |\n\n```ts\nconst a = 1;\n```\n\n> 结论"
    }],
    active: []
  });
  const lines = plainLines(view.render(44));
  const output = lines.join("\n");
  // 表格走框架的 Markdown 渲染：画成表格框，源码里的分隔行不再原样出现。
  assert.match(output, /┌.*┬.*┐/u);
  assert.match(output, /│ 模式\s+│ 数 │/u);
  assert.equal(output.includes("|---|"), false);
  // 代码块保留围栏标记并缩进内容。
  assert.match(output, /```ts/u);
  assert.match(output, /^ {3}const a = 1;/mu);
  assert.match(output, /结论/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 44, true, line);
}

function testToolBlockRendersTitleAndClampedOutput(): void {
  setTheme("dark");
  const item: ToolTranscriptItem = {
    id: "t1",
    kind: "tool",
    tool: "Bash",
    title: "Ran tests",
    argsSummary: "pnpm test",
    status: "success",
    output: "line one\nline two\nline three\nline four\nline five\nline six",
    details: "Command: pnpm test\nExit code: 0",
    durationMs: 1234
  };
  const component = new ToolExecutionComponent(item);
  const lines = plainLines(component.render(40));
  const text = lines.join("\n");
  assert.match(text, /✓ Ran tests\s+1\.2s/u);
  // 默认不展开工具输出，避免正常命令结果占满对话区。
  assert.equal(text.includes("line one"), false);
  assert.equal(text.includes("line six"), false);
  for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, line);

  assert.deepEqual(splitToolTitle("Ran tests"), { verb: "Ran", rest: " tests" });
  assert.deepEqual(splitToolTitle("Ran"), { verb: "Ran", rest: "" });
}

function testThinkingBlockDefersStreamingBody(): void {
  setTheme("dark");
  const streaming = new ThinkingComponent({ id: "r1", kind: "reasoning", content: "正在生成的长思考。", startedAtMs: Date.now() - 2300 });
  assert.doesNotMatch(plainLines(streaming.render(40)).join("\n"), /正在生成的长思考。/u);

  const component = new ThinkingComponent({ id: "r1", kind: "reasoning", content: "先看 transcript 的结构。", durationMs: 2300 });
  assert.doesNotMatch(plainLines(component.render(40)).join("\n"), /先看 transcript 的结构。/u);
  assert.match(plainLines(component.render(40)).join("\n"), /Thought for 2\.3s/u);
}

function testPendingAttachmentDisplay(): void {
  setTheme("dark");
  const component = new PendingAttachmentsComponent();
  component.setAttachments([
    { name: "screenshot.png", mimeType: "image/png", size: 1536, data: "image" },
    { name: "recording.mp3", mimeType: "audio/mpeg", size: 3, data: "audio" }
  ]);
  const lines = plainLines(component.render(40));
  assert.match(lines[0] ?? "", /\[Image #1\] · 1\.5 KB/u);
  assert.match(lines[1] ?? "", /\[Attachment #2\] · 3 B/u);
  assert.equal(pendingAttachmentLabel({ mimeType: "image/webp" }, 2), "[Image #3]");

  for (const line of plainLines(component.render(12))) {
    assert.equal(visibleWidth(line) <= 12, true, line);
  }
}

function testFooterAndChromeLayout(): void {
  setTheme("dark");
  const data = {
    cwd: "/tmp/workspace",
    sessionId: "0123456789abcdef",
    gitBranch: "main",
    modelLabel: "deepseek-v4-pro",
    thinkingLabel: "High",
    permissionMode: "ask" as const,
    mode: "chat" as const,
    contextUsedTokens: 2500,
    contextMaxTokens: 10_000
  };
  const layout = footerLayout(data, 100);
  assert.match(layout.workspace, /\/tmp\/workspace \(main\) • 01234567/u);
  // 日期前缀的会话 id 要取末段随机后缀，否则每个会话看起来都一样。
  assert.equal(shortSessionId("20260726-041954-481e7876"), "481e7876");
  assert.equal(shortSessionId("0123456789abcdef"), "01234567");
  assert.equal(shortSessionId("short"), "short");
  const stats = `${layout.context}${layout.meta}${layout.gap}${layout.model}`;
  assert.match(stats, /ctx 25%\/10k/u);
  assert.match(stats, /ask/u);
  assert.match(stats, /deepseek-v4-pro • high$/u);
  assert.equal(visibleWidth(stats), 100);

  const narrow = footerLayout({ ...data, modelLabel: "very-long-model-name" }, 12);
  assert.equal(visibleWidth(`${narrow.context}${narrow.meta}${narrow.gap}${narrow.model}`) <= 12, true);
  assert.equal(visibleWidth(narrow.workspace) <= 12, true);

  for (const line of plainLines(new FooterComponent(data).render(60))) {
    assert.equal(visibleWidth(line) <= 60, true, line);
  }

  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(2_500), "2.5k");
  assert.equal(formatTokens(128_000), "128k");
  assert.equal(formatTokens(2_000_000), "2.0M");
}

function testStatusAndShortcutHints(): void {
  setTheme("dark");
  assert.equal(statusMessage("running", 30_000, "◦"), "◦ Working (30s · esc to interrupt)");
  assert.equal(statusMessage("thinking", 1_234, "⠋"), "⠋ Working (1.2s · esc to interrupt)");
  assert.equal(statusMessage("waiting_permission", 30_000), "• Waiting for approval (30s)");
  assert.equal(statusMessage("idle", 30_000), "Worked for 30s");
  assert.equal(statusMessage("idle"), "");

  const divider = statusDivider("Worked for 9m 27s", 50);
  assert.match(divider, /^─ Worked for 9m 27s ─+$/u);
  assert.equal(visibleWidth(divider), 50);
  assert.equal(visibleWidth(statusDivider("Working", 2)), 2);

  const busy = shortcutHints("running").map((hint) => hint.key);
  assert.equal(busy.includes("esc"), true);
  assert.equal(busy.includes("ctrl+o"), false);
  assert.equal(shortcutHints("idle").some((hint) => hint.key === "shift+tab"), false);
  assert.equal(shortcutHints("idle").some((hint) => hint.key === "ctrl+e"), false);

  // 窄终端整条丢弃，不把单条提示截半句。
  const visible = visibleShortcutHints(shortcutHints("idle"), 14);
  const rendered = visible.map((hint) => `${hint.key} ${hint.description}`).join(" · ");
  assert.equal(visibleWidth(rendered) <= 14, true);

  const bar = new ShortcutsBarComponent();
  bar.setState("idle");
  for (const line of plainLines(bar.render(50))) assert.equal(visibleWidth(line) <= 50, true, line);
}

function testWelcomeRendersOnboarding(): void {
  setTheme("dark");
  const lines = plainLines(new WelcomeComponent("~/CodingAgent/biny", "0.2.2").render(70));
  const text = lines.join("\n");
  assert.match(text, /Biny v0\.2\.2/u);
  assert.match(text, /Workspace · ~\/CodingAgent\/biny/u);
  assert.match(text, /local agent is ready/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 70, true, line);
}

function testDialogsRenderAndHandleKeys(): void {
  setTheme("dark");
  let selected: string | undefined;
  let cancelled = false;
  const select = new SelectDialog({
    title: "Select model",
    items: [
      { value: "a", label: "alpha", description: "first" },
      { value: "b", label: "beta", description: "second" }
    ],
    onSelect: (item) => { selected = item.value; },
    onCancel: () => { cancelled = true; }
  });
  const selectText = plainLines(select.render(50)).join("\n");
  assert.match(selectText, /Select model/u);
  assert.match(selectText, /alpha/u);
  select.handleInput("\u001B[B");
  select.handleInput("\r");
  assert.equal(selected, "b");
  select.handleInput("\u001B");
  assert.equal(cancelled, true);

  let ctrlCCancelled = false;
  const ctrlCSelect = new SelectDialog({
    title: "Select command",
    items: [{ value: "model", label: "/model" }],
    onSelect: () => undefined,
    onCancel: () => { ctrlCCancelled = true; }
  });
  ctrlCSelect.handleInput("\u0003");
  assert.equal(ctrlCCancelled, true);

  let closed = false;
  const content = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join("\n");
  const viewer = new TextViewerDialog("Details", content, 5, () => { closed = true; });
  const firstPage = plainLines(viewer.render(40)).join("\n");
  assert.match(firstPage, /line 0/u);
  assert.equal(firstPage.includes("line 20"), false);
  viewer.handleInput("\u001B[6~");
  assert.match(plainLines(viewer.render(40)).join("\n"), /line 4/u);
  viewer.handleInput("\u001B");
  assert.equal(closed, true);

  // Ctrl+C 也关闭查看器：全局双 Ctrl+C 退出依赖弹层先消费掉第一次按键。
  let closedByCtrlC = false;
  const ctrlCViewer = new TextViewerDialog("Details", "body", 5, () => { closedByCtrlC = true; });
  ctrlCViewer.handleInput("\u0003");
  assert.equal(closedByCtrlC, true);
}

function testPermissionDialogRequiresFullYes(): void {
  setTheme("dark");
  const request: TuiPermissionRequest = {
    tool: "Bash",
    title: "Command execution request",
    details: "sudo example",
    requireFullYes: true,
    actionType: "shell",
    riskLevel: "critical"
  };
  const answers: Array<{ choice: PermissionChoice; denialReason?: string }> = [];
  let detailsToggled = 0;
  const dialog = new PermissionDialog(request, (choice, denialReason) => answers.push({ choice, denialReason }), () => { detailsToggled += 1; });

  const rendered = plainLines(dialog.render(60)).join("\n");
  assert.match(rendered, /允许运行此命令/u);
  assert.match(rendered, /关键或敏感内容/u);
  assert.match(rendered, /输入 yes，再按 Enter/u);

  // 强确认下直接回车不通过，要先输入完整 yes。
  dialog.handleInput("\r");
  assert.deepEqual(answers, []);
  assert.match(plainLines(dialog.render(60)).join("\n"), /请输入完整的 yes/u);
  for (const char of "yes") dialog.handleInput(char);
  dialog.handleInput("\r");
  assert.deepEqual(answers, [{ choice: "allow_once", denialReason: undefined }]);

  dialog.handleInput("\u000F");
  assert.equal(detailsToggled, 1);

  // 拒绝不需要确认词。
  const rejectAnswers: PermissionChoice[] = [];
  const rejectDialog = new PermissionDialog(request, (choice) => rejectAnswers.push(choice), () => undefined);
  rejectDialog.handleInput("\u001B");
  assert.deepEqual(rejectAnswers, ["deny"]);

  const reasonAnswers: Array<{ choice: PermissionChoice; denialReason?: string }> = [];
  const reasonDialog = new PermissionDialog(request, (choice, denialReason) => reasonAnswers.push({ choice, denialReason }), () => undefined);
  reasonDialog.handleInput("\u001B[A");
  for (const char of "not ready") reasonDialog.handleInput(char);
  reasonDialog.handleInput("\r");
  assert.deepEqual(reasonAnswers, [{ choice: "deny_with_reason", denialReason: "not ready" }]);

  const normalAnswers: PermissionChoice[] = [];
  const normalDialog = new PermissionDialog(
    { ...request, title: "Normal file edit", details: "File: example.ts", requireFullYes: false },
    (choice) => normalAnswers.push(choice),
    () => undefined
  );
  normalDialog.handleInput("\r");
  assert.deepEqual(normalAnswers, ["allow_once"]);

  const compactDialog = new PermissionDialog(
    { ...request, details: Array.from({ length: 30 }, (_, index) => `preview line ${String(index)}`).join("\n") },
    () => undefined,
    () => undefined,
    12
  );
  const compactText = plainLines(compactDialog.render(80)).join("\n");
  assert.match(compactText, /输入 yes，再按 Enter/u);
  assert.match(compactText, /Enter 确认/u);
  assert.match(compactText, /部分详情已收起/u);

  const fileBody = "secret implementation detail";
  const fileDialog = new PermissionDialog(
    {
      ...request,
      title: "File write request",
      details: "File: src/example.ts\nBytes: 31",
      preview: fileBody,
      requireFullYes: false,
      riskLevel: "write"
    },
    () => undefined,
    () => undefined
  );
  const conciseFileText = plainLines(fileDialog.render(80)).join("\n");
  assert.match(conciseFileText, /File: src\/example\.ts/u);
  assert.equal(conciseFileText.includes(fileBody), false);
  fileDialog.handleInput("\u000F");
  fileDialog.setDetailsExpanded(true);
  assert.match(plainLines(fileDialog.render(80)).join("\n"), /secret implementation detail/u);
}

function testTranscriptTextHelpers(): void {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  assert.equal(formatSessionAge("2026-07-30T12:00:00.000Z", now), "1d");
  assert.equal(formatSessionAge("2026-07-31T09:00:00.000Z", now), "3h");
  assert.equal(formatSessionAge("2026-07-31T11:45:00.000Z", now), "15m");
  assert.equal(formatSessionAge("not-a-time", now), "--");

  assert.equal(formatToolDuration(undefined), "");
  assert.equal(formatToolDuration(940), "940ms");
  assert.equal(formatToolDuration(1_234), "1.2s");
  assert.equal(formatToolDuration(75_000), "1m 15s");

}

async function testSlashAutocompleteInsertsSingleSlash(): Promise<void> {
  // 补全器要的是不带斜杠的命令名，传成 `/resume` 会补出 `//resume`。
  const provider = new CombinedAutocompleteProvider(
    slashCommandsForSurface("tui").map((command) => ({
      name: command.name.replace(/^\//, ""),
      description: command.description
    })),
    process.cwd()
  );

  const controller = new AbortController();
  const suggestions = await provider.getSuggestions(["/res"], 0, 4, { signal: controller.signal });
  assert.ok(suggestions);
  const resume = suggestions.items.find((item) => item.value === "resume");
  assert.ok(resume, "should suggest resume");

  const applied = provider.applyCompletion(["/res"], 0, 4, resume, suggestions.prefix);
  assert.deepEqual(applied.lines, ["/resume "]);

  // 分发时对多余斜杠有容错，避免历史输入或粘贴直接变成未知命令。
  assert.equal(normalizeSlashCommand("//resume"), "/resume");
  assert.equal(normalizeSlashCommand("/resume abc"), "/resume abc");
}

/** 与 app.ts 中 handleSlashCommand 的归一化保持一致。 */
function normalizeSlashCommand(value: string): string {
  return value.trim().replace(/^\/+/, "/");
}

await main();
