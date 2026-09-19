/**
 * 对话时间线：逐轮渲染用户消息、思考过程、助手回复和工具活动。
 *
 * 数据由 `buildSessionTimeline` 算好，这里只做渲染和局部交互（展开思考、复制、编辑重发、
 * 回滚文件等）。整体用 memo 包住，因为流式输出期间父组件会高频重渲染。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { SessionUsage } from "../../../../session/metadata.js";
import { splitAttachmentReferences, type AttachmentReference } from "../../../attachmentReferences.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { useInlineImage } from "../inlineImage.js";
import { listChangedFiles, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { hasSubmittedUserMessage, buildUsageDetailRows, finishReasonTone, formatDuration, formatMessageClock, parseCompactionNotice, shouldShowResponseContext, turnMetrics, type TurnMetrics } from "../chatModel.js";
import { speak, speechSupported } from "../speech.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { useTypewriter } from "./useTypewriter.js";
import { ActivitySegment, type ActivitySegmentStep } from "./chat/ActivitySegment.js";
import { CompactionDivider } from "./chat/CompactionDivider.js";
import { MessageClock } from "./chat/MessageClock.js";
import { SkillsIndicator } from "./chat/SkillsIndicator.js";
import { ChangesSummary } from "./chat/ChangesSummary.js";
import { RunStatus } from "./chat/RunStatus.js";

interface MessageTimelineProps {
  projectId: string;
  turns: TimelineTurn[];
  skillNames?: ReadonlyMap<string, string>;
  pendingUserMessage?: PendingUserMessage;
  /** 首条提交自空态切入：pending 气泡以上浮 FLIP 进入（submittedPreview 原文参数）。 */
  pendingFloatFromComposer?: boolean;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  thinking: boolean;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  /** 点「编辑」：把消息文本交给底部输入框（Alma 式编辑），提交由 Composer 走 App 回调。 */
  onEditRequest(turn: TimelineTurn): void;
  /** 进行中的编辑重写：App 提交时置位，替换回合出现后由 App 清除。 */
  editInFlight?: { turnId: string; user: string; userMessageIndex?: number };
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

interface PendingUserMessage {
  id: string;
  messageId?: string;
  content: string;
}

interface OptimisticRewrite {
  turnId: string;
  user: string;
  userMessageIndex?: number;
  assistantMessageId?: string;
  mode: "retry" | "edit";
  settled: boolean;
}

/** live 回合的 id 是 runId；状态停在 idle 说明 run.started 被丢过，由 runtime 的活动 run 兜底。 */
function turnIsRunning(turn: TimelineTurn, runtimeActiveRunId: string | undefined): boolean {
  if (turn.status === "running" || turn.status === "waiting_permission") return true;
  return runtimeActiveRunId !== undefined && turn.status === "idle" && turn.id === runtimeActiveRunId;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, turns, skillDescriptions, skillNamesBySelector, pendingUserMessage, pendingFloatFromComposer, runtimeActiveRunId, onPreviewFile, onOpenExternal, onResolvePermission, thinking, onRetry, onSwitchVersion, onEditRequest, editInFlight, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  // 重试会先把目标之后的消息从视图中撤掉，再等待新回合流入；这里保留同样的乐观投影。
  // 编辑的重写投影来自 App（editInFlight），提交入口在底部输入框，不经过本组件状态。
  const [optimisticRewrite, setOptimisticRewrite] = useState<OptimisticRewrite>();

  const startOptimisticRewrite = useCallback((turn: TimelineTurn, mode: OptimisticRewrite["mode"], user = turn.user): void => {
    setOptimisticRewrite({
      turnId: turn.id,
      user,
      userMessageIndex: turn.userMessageIndex,
      assistantMessageId: turn.assistantMessageId,
      mode,
      settled: false
    });
  }, []);

  const settleOptimisticRewrite = useCallback((turnId: string, succeeded: boolean): void => {
    setOptimisticRewrite((current) => {
      if (!current || current.turnId !== turnId) return current;
      return succeeded ? { ...current, settled: true } : undefined;
    });
  }, []);

  // 编辑投影与重试投影共用同一套渲染；编辑投影的清除（替换回合已出现）由 App 负责。
  const rewrite: OptimisticRewrite | undefined = useMemo(
    () => optimisticRewrite ?? (editInFlight
      ? { turnId: editInFlight.turnId, user: editInFlight.user, userMessageIndex: editInFlight.userMessageIndex, mode: "edit", settled: false }
      : undefined),
    [optimisticRewrite, editInFlight]
  );

  useEffect(() => {
    const pending = optimisticRewrite;
    if (!pending?.settled || pending.mode !== "retry") return;
    const target = turns.find((turn) => turn.id === pending.turnId);
    const hasRetryReplacement = target !== undefined
      && (target.retryOfMessageId !== undefined
        || target.assistantMessageId !== pending.assistantMessageId);
    if (hasRetryReplacement) {
      setOptimisticRewrite((current) => current?.turnId === pending.turnId ? undefined : current);
    }
  }, [optimisticRewrite, turns]);

  const hasRealPendingMessage = pendingUserMessage !== undefined
    && hasSubmittedUserMessage(turns, pendingUserMessage.messageId, pendingUserMessage.content);
  // FLIP 落定标记：pending 以 FLIP 进入后，被真实回合接管的首条用户消息只播扫光
  // （原文 animateUserEntry "sheen-only"），避免「上浮完又浮入」的二次入场。
  const [flipArrived, setFlipArrived] = useState(false);
  useEffect(() => {
    if (pendingFloatFromComposer) setFlipArrived(true);
  }, [pendingFloatFromComposer]);
  // 切换项目时清除标记（跳过首挂载，否则会把同批置位的标记清掉），避免误伤新会话的首条消息。
  const mountedForProjectRef = useRef(false);
  useEffect(() => {
    if (!mountedForProjectRef.current) {
      mountedForProjectRef.current = true;
      return;
    }
    setFlipArrived(false);
  }, [projectId]);
  const firstTurnSheenOnly = flipArrived && pendingUserMessage === undefined;
  const displayedTurns = useMemo(() => {
    const pending = rewrite;
    if (!pending) return turns;
    const targetIndex = turns.findIndex((turn) => turn.id === pending.turnId);
    const replacementIndex = targetIndex >= 0
      ? targetIndex
      : pending.userMessageIndex === undefined
        ? -1
        : turns.findIndex((turn) => turn.userMessageIndex === pending.userMessageIndex && turn.user === pending.user);
    if (replacementIndex >= 0) {
      const target = turns[replacementIndex];
      if (!target) return turns;
      return [...turns.slice(0, replacementIndex), optimisticRewriteTurn(target, pending.user)];
    }
    return [...turns, optimisticRewriteTurn({
      id: pending.turnId,
      user: pending.user,
      userMessageIndex: pending.userMessageIndex,
      userMessageId: undefined,
      assistant: "",
      assistantMessageId: undefined,
      versionSlotId: undefined,
      versionIndex: undefined,
      versionCount: undefined,
      retryOfMessageId: undefined,
      reasoning: "",
      reasoningStatus: undefined,
      reasoningDurationMs: undefined,
      reasoningStartedAt: undefined,
      skills: [],
      status: "running",
      model: undefined,
      tools: [],
      steps: [],
      error: undefined,
      durationMs: undefined,
      usage: undefined,
      timestamp: undefined,
      resumable: undefined,
      firstTokenAt: undefined,
      startedAt: undefined,
      ttftMs: undefined,
      decodeMs: undefined,
      decodeTokens: undefined,
      finishReason: undefined
    }, pending.user)];
  }, [rewrite, turns]);

  const busy = thinking || Boolean(rewrite) || displayedTurns.some((turn) => turnIsRunning(turn, runtimeActiveRunId));
  // 失败状态跟随对应消息，切会话、重启后仍可定位和重试。
  return (
    <div className="message-timeline">
      {pendingUserMessage && !hasRealPendingMessage ? (
        <PendingUserMessage
          content={pendingUserMessage.content}
          floatFromComposer={pendingFloatFromComposer === true}
          id={pendingUserMessage.id}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          projectId={projectId}
        />
      ) : null}
      {displayedTurns.map((turn, index) => (
        <Turn
          busy={busy}
          entrySheenOnly={firstTurnSheenOnly && index === 0}
          skillNames={skillNames}
          key={turn.id}
          onCreateBranch={onCreateBranch}
          onDeleteUserMessage={onDeleteUserMessage}
          onEditRequest={onEditRequest}
          onPreviewFile={onPreviewFile}
          onOpenExternal={onOpenExternal}
          onResolvePermission={onResolvePermission}
          onRollbackFiles={onRollbackFiles}
          onRetry={onRetry}
          onRetryStart={startOptimisticRewrite}
          onRetrySettled={settleOptimisticRewrite}
          onSwitchVersion={onSwitchVersion}
          projectId={projectId}
          runtimeActiveRunId={runtimeActiveRunId}
          turn={turn}
        />
      ))}
      {thinking && !displayedTurns.some((turn) => turnIsRunning(turn, runtimeActiveRunId)) ? <RunStatus /> : null}
    </div>
  );
});

const PendingUserMessage = memo(function PendingUserMessage({ content, floatFromComposer, id, onOpenExternal, onPreviewFile, projectId }: {
  content: string;
  /** 首条提交自空态切入：气泡自输入框位置上浮到时间线槽位（submittedPreview 原文参数）。 */
  floatFromComposer: boolean;
  id: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  const message = splitAttachmentReferences(content);
  const bubbleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!floatFromComposer) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bubble = bubbleRef.current;
    if (!bubble) return;
    // 起点 = 底部输入框顶缘；终点 = 气泡自然槽位；
    // 运动 = y(delta→0) + 淡入，0.5s cubic-bezier(.32,.72,0,1)（原文 motion 参数）。
    const bubbleTop = bubble.getBoundingClientRect().top;
    const startY = document.querySelector(".biny-chat-composer .biny-composer-frame")?.getBoundingClientRect().top
      ?? window.innerHeight - 160;
    const delta = startY - bubbleTop;
    if (delta <= 8) return;
    // FLIP 期间压掉 CSS 入场（浮入/扫光由落定后的 sheen-only 接管）。
    bubble.classList.add("is-flip-enter");
    const animation = bubble.animate(
      [
        { opacity: 0, transform: `translateY(${String(delta)}px)` },
        { opacity: 1, transform: "translateY(0)" }
      ],
      { duration: 500, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
    );
    const settle = (): void => bubble.classList.remove("is-flip-enter");
    animation.onfinish = settle;
    animation.oncancel = settle;
    return () => {
      animation.cancel();
      settle();
    };
  }, [floatFromComposer]);
  return (
    <article className="chat-message user-message is-pending-entry" data-message-id={id} data-sender="user">
      <div className="user-bubble" ref={bubbleRef}>
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </div>
    </article>
  );
});

function optimisticRewriteTurn(turn: TimelineTurn, user: string): TimelineTurn {
  return {
    ...turn,
    user,
    assistant: "",
    reasoning: "",
    reasoningStatus: undefined,
    reasoningDurationMs: undefined,
    reasoningStartedAt: undefined,
    skills: [],
    memoryInjectedCount: undefined,
    memoryInjectedSummaries: undefined,
    preparationStage: undefined,
    capabilitySelection: undefined,
    status: "running",
    model: undefined,
    tools: [],
    steps: [],
    error: undefined,
    durationMs: undefined,
    usage: undefined,
    firstTokenAt: undefined,
    startedAt: undefined,
    timestamp: undefined,
    ttftMs: undefined,
    decodeMs: undefined,
    decodeTokens: undefined,
    finishReason: undefined
  };
}

const Turn = memo(function Turn({
  busy,
  entrySheenOnly,
  skillNames,
  projectId,
  turn,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  onRetry,
  onRetryStart,
  onRetrySettled,
  onSwitchVersion,
  onEditRequest,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  busy: boolean;
  /** FLIP 落定后的首条用户消息只播扫光（原文 animateUserEntry "sheen-only"）。 */
  entrySheenOnly?: boolean;
  skillNames?: ReadonlyMap<string, string>;
  projectId: string;
  turn: TimelineTurn;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onRetryStart(turn: TimelineTurn, mode: "retry" | "edit", user?: string): void;
  onRetrySettled(turnId: string, succeeded: boolean): void;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onEditRequest(turn: TimelineTurn): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const running = turnIsRunning(turn, runtimeActiveRunId);
  const retryPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const retry = useCallback((): Promise<void> => {
    if (running || busy) return Promise.resolve();
    const targetMessageId = turn.assistantMessageId ?? turn.userMessageId;
    if (!turn.user || !targetMessageId) return Promise.resolve();
    const existing = retryPromiseRef.current;
    if (existing) return existing;
    onRetryStart(turn, "retry");
    const pending = Promise.resolve().then(() => onRetry(targetMessageId, turn.user, globalThis.crypto.randomUUID()));
    retryPromiseRef.current = pending;
    void pending.then(
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, true);
      },
      () => {
        if (retryPromiseRef.current === pending) retryPromiseRef.current = undefined;
        onRetrySettled(turn.id, false);
      }
    );
    return pending;
  }, [busy, onRetry, onRetrySettled, onRetryStart, running, turn]);
  const switchVersion = useCallback((direction: "prev" | "next"): Promise<void> => {
    if (!turn.assistantMessageId) return Promise.resolve();
    return onSwitchVersion(turn.assistantMessageId, direction);
  }, [onSwitchVersion, turn.assistantMessageId]);
  const canRetry = !running && !busy && Boolean(turn.user && (turn.assistantMessageId ?? turn.userMessageId));
  // 开始事件不证明收到过思考；等待由状态行展示，避免出现点开后为空的活动记录。
  const executionSteps = turn.steps.filter((step) => {
    if (step.kind === "reasoning") return step.notice || step.content.trim();
    if (step.kind === "assistant") return step.content.trim();
    return true;
  });
  // 收尾的「修改文件」卡：只在本轮真正落定（非运行态）且存在完成写入/编辑时出现。
  const completedChangedFiles = useMemo(
    () => running ? [] : listChangedFiles(turn).filter((file) => file.status === "completed"),
    [running, turn]
  );
  return (
    <section className={`timeline-turn is-${turn.status}`}>
      {turn.user ? (
        <UserMessage
          content={turn.user}
          entrySheenOnly={entrySheenOnly === true}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          onCreateBranch={onCreateBranch}
          onDelete={() => onDeleteUserMessage(turn.id)}
          onEdit={() => onEditRequest(turn)}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          onRegenerate={canRetry ? retry : undefined}
          onRollbackFiles={() => onRollbackFiles(turn)}
          projectId={projectId}
          time={turn.timestamp}
        />
      ) : null}
      {/* 运行中保留状态反馈；结束后不凭空补出助手内容。 */}
      {running || executionSteps.length > 0 || turn.assistant.trim() || completedChangedFiles.length > 0 ? (
      <article className="chat-message desktop-assistant-message" data-sender="assistant">
        <div className="agent-response">
        {shouldShowResponseContext(turn) ? <SkillsIndicator skillNames={skillNames} memoryInjectedSummaries={turn.memoryInjectedSummaries} skills={turn.skills} tools={turn.tools.map((tool) => tool.tool)} /> : null}
        {executionSteps.length ? (
          <ExecutionTimeline
            onPreviewFile={onPreviewFile}
            onOpenExternal={onOpenExternal}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            running={running}
            steps={executionSteps}
            thinkingSeconds={turn.reasoningDurationMs !== undefined ? Math.max(1, Math.round(turn.reasoningDurationMs / 1000)) : undefined}
          />
        ) : null}
        {!executionSteps.some((step) => step.kind === "assistant") && turn.assistant ? <TypewriterMarkdown active={running} content={turn.assistant} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {running ? <RunStatus turn={turn} /> : null}

        {!running && turn.assistant.trim() ? (
          <AssistantActions
            content={turn.assistant}
            finishReason={turn.finishReason}
            metrics={turnMetrics(turn)}
            onCreateBranch={onCreateBranch}
            onRegenerate={canRetry ? retry : undefined}
            onSwitchVersion={turn.versionCount && turn.versionCount > 1 ? switchVersion : undefined}
            runMs={turn.durationMs}
            timestamp={turn.timestamp}
            usage={turn.usage}
            versionCount={turn.versionCount}
            versionIndex={turn.versionIndex}
          />
        ) : null}

        {completedChangedFiles.length ? (
          <ChangesSummary files={completedChangedFiles} onPreviewFile={onPreviewFile} />
        ) : null}

        </div>
      </article>
      ) : null}
      {!running && !turn.assistant.trim() && turn.versionCount && turn.versionCount > 1 && turn.versionIndex !== undefined ? (
        <VersionSwitcher onSwitchVersion={switchVersion} versionCount={turn.versionCount} versionIndex={turn.versionIndex} />
      ) : null}
    </section>
  );
});

/** 流式打字机版 Markdown：仅 reveal 新增量，历史/完结内容直出 */
const TypewriterMarkdown = memo(function TypewriterMarkdown({ active, content, onOpenExternal, onPreviewFile, projectId }: {
  active: boolean;
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  const typed = useTypewriter(content, active);
  return (
    <div className={active ? "with-streaming-cursor" : undefined}>
      <MarkdownContent content={typed} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
});

function ExecutionTimeline({
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  projectId,
  running,
  steps,
  thinkingSeconds
}: {
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  projectId: string;
  running: boolean;
  steps: TimelineStep[];
  /** 轮次级思考耗时（秒）；纯思考段的「已思考 N 秒」兜底。 */
  thinkingSeconds?: number;
}): React.JSX.Element {
  const entries = groupExecutionSteps(steps);
  return (
    <div className="execution-timeline">
      {entries.map((entry, index) => {
        // 思考 + 工具（无论几个）一律进活动段：单步骤呈现为一枚相位头像 + 一行摘要。
        if (Array.isArray(entry)) {
          return (
            <ActivitySegment
              key={entry[0]?.id ?? "activity-segment"}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              projectId={projectId}
              running={running && index === entries.length - 1}
              steps={entry}
              thinkingSeconds={thinkingSeconds}
            />
          );
        }
        const step = entry;
        if (step.kind === "reasoning") {
          // 上下文压缩标记渲染为独立的压缩分隔条（居中药丸）。
          if (step.notice === "compaction") {
            const notice = parseCompactionNotice(step.status);
            return <CompactionDivider count={notice.count} key={step.id} savedTokens={notice.savedTokens} summary={step.content || undefined} />;
          }
          // 孤立思考也走活动段（纯思考段：一枚头像 + 「已思考 N 秒」）。
          return (
            <ActivitySegment
              key={step.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              projectId={projectId}
              running={running && index === entries.length - 1}
              steps={[step]}
              thinkingSeconds={thinkingSeconds}
            />
          );
        }
        if (step.kind === "user") {
          return (
            <div className="execution-step execution-user-step user-message" key={step.id}>
              <div className="user-bubble"><MarkdownContent breaks content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>
            </div>
          );
        }
        if (step.kind === "tool") return null;
        if (step.summary) {
          return (
            <ActivitySummaryStep
              content={step.content}
              key={step.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              projectId={projectId}
            />
          );
        }
        return <div className="execution-step execution-assistant-step" key={step.id}><TypewriterMarkdown active={running && index === entries.length - 1 && !step.completed} content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>;
      })}
    </div>
  );
}

/**
 * 把连续的可聚合步骤（工具调用 + 思考）收成一组；其余步骤原样保留顺序。
 *
 * 思考不把工具组切断：reasoning 步骤与相邻 tool 步骤进同一个活动段。压缩标记
 * （notice === "compaction"）、assistant 正文/摘要、用户插话仍然是分组断点。
 * 单个步骤也保留为活动段，使思考或工具调用与多步骤活动使用同一套展开行为。
 */
function groupExecutionSteps(steps: TimelineStep[]): Array<TimelineStep | ActivitySegmentStep[]> {
  const grouped: Array<TimelineStep | ActivitySegmentStep[]> = [];
  for (const step of steps) {
    if (!isGroupableStep(step)) {
      grouped.push(step);
      continue;
    }
    const last = grouped.at(-1);
    if (Array.isArray(last)) last.push(step);
    else grouped.push([step]);
  }
  return grouped;
}

function isGroupableStep(step: TimelineStep): step is ActivitySegmentStep {
  if (step.kind === "tool") return true;
  return step.kind === "reasoning" && step.notice !== "compaction";
}

function ActivitySummaryStep({ content, onOpenExternal, onPreviewFile, projectId }: {
  content: string;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  projectId: string;
}): React.JSX.Element {
  return (
    <div className="execution-step execution-assistant-step execution-summary-step">
      <MarkdownContent content={content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
}

function UserMessage({
  content,
  entrySheenOnly,
  hasChangedFiles,
  onCreateBranch,
  onDelete,
  onEdit,
  onOpenExternal,
  onPreviewFile,
  onRegenerate,
  onRollbackFiles,
  projectId,
  time
}: {
  content: string;
  /** 只播高光扫光、跳过浮入（FLIP 落定后的首条消息）。 */
  entrySheenOnly?: boolean;
  hasChangedFiles: boolean;
  onCreateBranch(): void;
  onDelete(): void;
  onEdit(): void;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  onRegenerate?(): Promise<void>;
  onRollbackFiles(): void;
  projectId: string;
  /** 消息时间（ISO 字符串）；存在时操作行前置 hover 揭示的日期感知时钟。 */
  time?: string;
}): React.JSX.Element {
  // 更多菜单走 portal fixed 定位（与助手菜单共用 hook），内联渲染会把消息列表往下挤。
  const { open: menuOpen, position: menuPosition, anchorRef: moreAnchorRef, menuRef, toggle, close: closeMenu } = useAnchoredMenu({ width: 208, estimatedHeight: 180 });
  // 删除烟化（message-smoke-out 原文）：先播 .6s 烟化动画，750ms 后再真正删除。
  const [smokingOut, setSmokingOut] = useState(false);
  const smokeTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (smokeTimerRef.current !== undefined) window.clearTimeout(smokeTimerRef.current);
  }, []);
  const requestDelete = (): void => {
    if (smokingOut) return;
    setSmokingOut(true);
    smokeTimerRef.current = window.setTimeout(onDelete, 750);
  };
  // 发送时追加给模型的附件清单不该原样显示，拆出来渲染成附件卡片。
  const message = useMemo(() => splitAttachmentReferences(content), [content]);
  const clock = time ? <MessageClock time={Date.parse(time)} /> : null;
  return (
    <article className={`chat-message user-message${entrySheenOnly ? " is-sheen-only" : ""}${smokingOut ? " message-smoke-out" : ""}`} data-sender="user">
      <div className="user-bubble">
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </div>
      <div className={`user-message-actions${menuOpen ? " is-open" : ""}`} data-time-hover-root>
        {clock}
        <button aria-label="复制消息" className="user-message-action" onClick={() => copyText(message.text)} title="复制消息" type="button"><Icon name="copy" size={16} /></button>
        {onRegenerate ? <button aria-label="重新生成" className="user-message-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button> : null}
        <button aria-label="编辑消息" className="user-message-action" onClick={onEdit} title="编辑消息" type="button"><Icon name="edit" size={16} /></button>
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多消息操作" className="user-message-action" onClick={toggle} ref={moreAnchorRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div className="message-menu" data-direction={menuPosition.direction} ref={menuRef} role="menu" style={menuPosition.style}>
          <button className="message-menu-item" onClick={() => { copyText(message.text); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
          <button className="message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(message.text)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
          <button className="message-menu-item" disabled={!hasChangedFiles} onClick={() => { onRollbackFiles(); closeMenu(); }} role="menuitem" title={hasChangedFiles ? "回滚本条消息产生的文件修改" : "当前消息没有可回滚的文件修改"} type="button"><Icon name="arrow-left" size={14} /><span>回滚文件</span></button>
          <div className="message-menu-separator" />
          <button className="message-menu-item is-danger" onClick={() => { closeMenu(); requestDelete(); }} role="menuitem" type="button"><Icon name="trash" size={14} /><span>删除消息</span></button>
        </div>,
        document.body
      ) : null}
    </article>
  );
}

function copyText(content: string): void {
  void copyToClipboard(content);
}

function plainTextFromMarkdown(content: string): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .trim();
}

/** 助手回复下方的操作条：
 *  复制/朗读/重新生成/更多 四个图标按钮 hover 揭示；日期感知时钟 + 运行指标
 *  （LLM 用时 / 首 token / 解码吞吐）常显。更多菜单与用量悬浮卡都走 portal
 *  fixed 定位：用量项悬停出详情卡（80ms 悬停意图防抖），结束原因带语义色点，
 *  复制成功后图标变勾并延迟收菜单。 */
function AssistantActions({ content, timestamp, metrics, runMs, usage, finishReason, onCreateBranch, onRegenerate, onSwitchVersion, versionIndex, versionCount }: {
  content: string;
  timestamp?: string;
  metrics?: TurnMetrics;
  runMs?: number;
  usage?: SessionUsage;
  finishReason?: string;
  onCreateBranch(): void;
  onRegenerate?(): Promise<void>;
  onSwitchVersion?(direction: "prev" | "next"): Promise<void>;
  versionIndex?: number;
  versionCount?: number;
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false);
  const stopSpeechRef = useRef<() => void>(undefined);
  const usageRows = buildUsageDetailRows(usage, metrics ?? {});
  const tone = finishReason ? finishReasonTone(finishReason) : undefined;
  // 更多菜单走 portal fixed 定位；条目数按需增减（用量/结束原因 + 分隔线），高度用于弹出方向判断。
  const menuItemCount = 3 + (usageRows.length ? 1 : 0) + (finishReason ? 1 : 0) + ((usageRows.length || finishReason) ? 1 : 0);
  const { open: menuOpen, position: menuPosition, anchorRef: moreButtonRef, menuRef, toggle: toggleMenu, close: closeMenu } = useAnchoredMenu({ width: 208, estimatedHeight: menuItemCount * 32 + 12 });
  const usageItemRef = useRef<HTMLButtonElement>(null);
  const [usagePopover, setUsagePopover] = useState<{ top: number; left: number }>();
  const usageHideTimerRef = useRef<number | undefined>(undefined);
  const [copiedKind, setCopiedKind] = useState<"markdown" | "plain">();

  // 组件卸载（切会话、消息被折叠）时朗读与悬浮卡定时器都要跟着停。
  useEffect(() => () => {
    stopSpeechRef.current?.();
    if (usageHideTimerRef.current !== undefined) window.clearTimeout(usageHideTimerRef.current);
  }, []);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeechRef.current?.();
      return;
    }
    setSpeaking(true);
    stopSpeechRef.current = speak(plainTextFromMarkdown(content), () => setSpeaking(false));
  };

  const cancelUsageHide = useCallback((): void => {
    if (usageHideTimerRef.current === undefined) return;
    window.clearTimeout(usageHideTimerRef.current);
    usageHideTimerRef.current = undefined;
  }, []);

  const scheduleUsageHide = useCallback((): void => {
    cancelUsageHide();
    usageHideTimerRef.current = window.setTimeout(() => {
      usageHideTimerRef.current = undefined;
      setUsagePopover(undefined);
    }, 80);
  }, [cancelUsageHide]);

  // 用量悬浮卡贴用量菜单项右侧（放不下换左侧），垂直方向与条目居中对齐。
  const showUsagePopover = useCallback((): void => {
    if (!usageRows.length) return;
    cancelUsageHide();
    const anchor = usageItemRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const gap = 10;
    const width = 240;
    let left = anchor.right + gap + width <= window.innerWidth ? anchor.right + gap : anchor.left - gap - width;
    left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - width - gap));
    const top = Math.min(Math.max(anchor.top + anchor.height / 2, gap), window.innerHeight - gap);
    setUsagePopover({ top, left });
  }, [usageRows.length, cancelUsageHide]);

  // 菜单收起时悬浮卡与复制成功态一并复位。
  useEffect(() => {
    if (menuOpen) return;
    cancelUsageHide();
    setUsagePopover(undefined);
    setCopiedKind(undefined);
  }, [menuOpen, cancelUsageHide]);

  const copyAs = (kind: "markdown" | "plain"): void => {
    copyText(kind === "markdown" ? content : plainTextFromMarkdown(content));
    setCopiedKind(kind);
    window.setTimeout(() => {
      setCopiedKind(undefined);
      closeMenu();
    }, 800);
  };

  const durationText = useMemo(() => {
    const parts: string[] = [];
    if (timestamp) {
      parts.push(formatMessageClock(Date.parse(timestamp)));
    }
    if (runMs !== undefined) {
      parts.push(`Worked for ${formatDuration(runMs)}`);
    } else if (metrics?.llmMs !== undefined) {
      parts.push(`LLM ${formatDuration(metrics.llmMs)}`);
    }
    return parts.join(" · ");
  }, [runMs, metrics, timestamp]);
  // 失败轮可能没有任何正文：复制/朗读无从作用，只保留重试、版本与更多菜单。
  const hasContent = content.trim().length > 0;
  const hasInfoSection = usageRows.length > 0 || Boolean(finishReason);
  return (
    <div className={`assistant-actions${menuOpen ? " is-open" : ""}`}>
      <div className="assistant-actions-duration">
        <Icon name="activity" size={14} />
        <span>{durationText}</span>
      </div>
      <div className="assistant-actions-buttons">
        {hasContent ? <CopyButton className="assistant-action" label="复制回复" size={16} value={content} /> : null}
        {hasContent && speechSupported() ? (
          <button aria-label={speaking ? "停止朗读" : "朗读回复"} className={`assistant-action${speaking ? " is-active" : ""}`} onClick={toggleSpeech} title={speaking ? "停止朗读" : "朗读回复"} type="button"><Icon name={speaking ? "volume-off" : "volume"} size={16} /></button>
        ) : null}
        {onRegenerate ? (
          <button aria-label="重新生成" className="assistant-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button>
        ) : null}
        {onSwitchVersion && versionCount !== undefined && versionCount > 1 && versionIndex !== undefined ? (
          <VersionSwitcher
            onSwitchVersion={onSwitchVersion}
            versionCount={versionCount}
            versionIndex={versionIndex}
          />
        ) : null}
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多回复操作" className="assistant-action" onClick={toggleMenu} ref={moreButtonRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div
          className="message-menu"
          data-direction={menuPosition.direction}
          onClick={(event) => event.stopPropagation()}
          ref={menuRef}
          role="menu"
          style={menuPosition.style}
        >
          {hasInfoSection ? (
            <>
              {usageRows.length ? (
                <button
                  className="message-menu-item"
                  onBlur={scheduleUsageHide}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                  onFocus={showUsagePopover}
                  onMouseEnter={showUsagePopover}
                  onMouseLeave={scheduleUsageHide}
                  ref={usageItemRef}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="info" size={14} /><span>用量</span>
                </button>
              ) : null}
              {finishReason && tone ? (
                <div className="message-menu-item is-static" role="menuitem">
                  <span aria-hidden="true" className={`finish-reason-dot is-${tone}`} />
                  <span className="finish-reason-label">Turn 结束原因</span>
                  <span className="finish-reason-value">{finishReason}</span>
                </div>
              ) : null}
              <div className="message-menu-separator" />
            </>
          ) : null}
          {hasContent ? (
            <>
              <button className={`message-menu-item${copiedKind === "markdown" ? " is-success" : ""}`} onClick={() => copyAs("markdown")} role="menuitem" type="button">
                <Icon name={copiedKind === "markdown" ? "check" : "copy"} size={14} /><span>复制为 Markdown</span>
              </button>
              <button className={`message-menu-item${copiedKind === "plain" ? " is-success" : ""}`} onClick={() => copyAs("plain")} role="menuitem" type="button">
                <Icon name={copiedKind === "plain" ? "check" : "copy"} size={14} /><span>复制为纯文本</span>
              </button>
            </>
          ) : null}
          <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
        </div>,
        document.body
      ) : null}
      {usagePopover && usageRows.length ? createPortal(
        <div
          className="usage-detail-popover"
          onMouseEnter={cancelUsageHide}
          onMouseLeave={scheduleUsageHide}
          role="status"
          style={{ top: usagePopover.top, left: usagePopover.left }}
        >
          <div className="usage-detail-title">用量</div>
          <div className="usage-detail-rows">
            {usageRows.map((row) => (
              <div className="usage-detail-row" key={row.key}>
                <span className="usage-detail-label">{row.label}</span>
                <span className="usage-detail-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

/** 消息版本控件：箭头、当前版本/总版本，跟随回复操作条显示。 */
function VersionSwitcher({ onSwitchVersion, versionIndex, versionCount }: {
  onSwitchVersion(direction: "prev" | "next"): Promise<void>;
  versionIndex: number;
  versionCount: number;
}): React.JSX.Element {
  const [pending, setPending] = useState<"prev" | "next">();
  const switchVersion = async (direction: "prev" | "next"): Promise<void> => {
    if (pending) return;
    setPending(direction);
    try {
      await onSwitchVersion(direction);
    } finally {
      setPending(undefined);
    }
  };
  return (
    <div aria-label="回复版本" className="message-version-switcher">
      <button
        aria-label="上一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("prev"); }}
        title="上一版本"
        type="button"
      >‹</button>
      <span className="message-version-count">{versionIndex + 1} / {versionCount}</span>
      <button
        aria-label="下一版本"
        className="assistant-action message-version-button"
        disabled={pending !== undefined}
        onClick={() => { void switchVersion("next"); }}
        title="下一版本"
        type="button"
      >›</button>
    </div>
  );
}

/** 用户消息里的附件：图片直接显示缩略图，其他类型退回成带文件名的卡片。 */
function MessageAttachments({ attachments, projectId }: { attachments: AttachmentReference[]; projectId: string }): React.JSX.Element {
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentCard attachment={attachment} key={attachment.path} projectId={projectId} />
      ))}
    </div>
  );
}

function AttachmentCard({ attachment, projectId }: { attachment: AttachmentReference; projectId: string }): React.JSX.Element {
  const isImage = attachment.mimeType?.startsWith("image/") ?? false;
  const source = useInlineImage(projectId, isImage ? attachment.path : "");
  if (source) return <img alt={attachment.name} className="message-attachment-image" src={source} title={attachment.name} />;
  return (
    <div className="message-attachment" title={attachment.path}>
      <Icon name={isImage ? "spark" : "file"} size={13} />
      <span>{attachment.name}</span>
    </div>
  );
}

/**
 * 消息"更多"菜单的开合与 fixed 定位：菜单通过 portal 挂到 document.body（脱离消息列表文档流，
 * 不会被滚动容器裁剪），打开时按锚点按钮的视口位置算坐标，下方放不下就向上弹；
 * 点击锚点/菜单以外、Esc、滚动或缩放窗口时收起。portal 不在组件 DOM 树内，
 * 外部点击判断必须显式比对锚点和菜单两个 ref。
 */
function useAnchoredMenu({ width, estimatedHeight }: { width: number; estimatedHeight: number }): {
  open: boolean;
  position: { direction: "up" | "down"; style: CSSProperties } | undefined;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  toggle(): void;
  close(): void;
} {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ direction: "up" | "down"; style: CSSProperties }>();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((): void => setOpen(false), []);

  const toggle = useCallback((): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) {
      setOpen(true);
      return;
    }
    const gap = 6;
    const spaceBelow = window.innerHeight - anchor.bottom - gap;
    const direction = spaceBelow >= estimatedHeight || spaceBelow >= anchor.top - gap ? "down" : "up";
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    setPosition(direction === "down"
      ? { direction, style: { left, top: anchor.bottom + gap } }
      : { direction, style: { left, bottom: window.innerHeight - anchor.top + gap } });
    setOpen(true);
  }, [open, estimatedHeight, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const dismiss = (): void => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return { open, position, anchorRef, menuRef, toggle, close };
}
