import { summarizeToolOptimizations } from "../../../../session/toolOptimization.js";
import { useChatResponseSettings } from "../chatResponseSettings.js";
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
import { AttachmentCard } from "./AttachmentCard.js";
import { listChangedFiles, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { hasSubmittedUserMessage, buildUsageDetailRows, finishReasonTone, formatDuration, formatMessageClock, parseCompactionNotice, turnMetrics, type TurnMetrics } from "../chatModel.js";
import { speak, speechSupported } from "../speech.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { useTypewriter } from "./useTypewriter.js";
import { ActivitySegment, type ActivitySegmentStep } from "./chat/ActivitySegment.js";
import { CompactionDivider } from "./chat/CompactionDivider.js";
import { CompactionStatus } from "./chat/CompactionStatus.js";
import { MessageClock } from "./chat/MessageClock.js";
import { MessageContextMenu } from "./chat/MessageContextMenu.js";
import { ExecutionTraceDialog } from "./chat/ExecutionTraceDialog.js";
import { ChangesSummary } from "./chat/ChangesSummary.js";
import { RunStatus } from "./chat/RunStatus.js";
import { SubagentActivity } from "./chat/SubagentActivity.js";
import { UserInputCard } from "./chat/UserInputCard.js";
import type { SavedQueuedMessage } from "../../../../session/queuedMessages.js";

interface MessageTimelineProps {
  externalAgent?: boolean;
  sessionId?: string;
  readOnly?: boolean;
  projectId: string;
  turns: TimelineTurn[];
  skillDescriptions?: ReadonlyMap<string, string>;
  skillLabels?: ReadonlyMap<string, string>;
  pendingUserMessage?: PendingUserMessage;
  /** Runtime snapshot 里当前会话的活动 run；live 回合丢了 run.started（状态停在 idle）时以它兜底。 */
  runtimeActiveRunId?: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onReferenceMessage(messageId: string): void;
  onShowMessageReferences(messageId: string): void;
  onAddQuoteToConversation(messageId: string, quote: string): Promise<void>;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  thinking: boolean;
  compacting?: boolean;
  onRetry(targetMessageId: string, input: string, attachments: AttachmentReference[], idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  /** 点「编辑」：把消息文本交给底部输入框，提交由 Composer 走 App 回调。 */
  onEditRequest(turn: TimelineTurn): void;
  /** 进行中的编辑重写：App 提交时置位，替换回合出现后由 App 清除。 */
  editInFlight?: { turnId: string; user: string; userMessageIndex?: number };
  onCreateBranch?(): void;
  onRollbackFiles(turn: TimelineTurn): void;
}

interface PendingUserMessage {
  id: string;
  messageId: string;
  content: string;
  attachments?: AttachmentReference[];
}

interface OptimisticRewrite {
  turnId: string;
  user: string;
  userMessageIndex?: number;
  assistantMessageId?: string;
  mode: "retry" | "edit";
  settled: boolean;
}

interface QuoteSelectionOwner {
  messageId: string;
  quote: string;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

/** live 回合的 id 是 runId；状态停在 idle 说明 run.started 被丢过，由 runtime 的活动 run 兜底。 */
function turnIsRunning(turn: TimelineTurn, runtimeActiveRunId: string | undefined): boolean {
  if (turn.status === "running" || turn.status === "waiting_permission") return true;
  return runtimeActiveRunId !== undefined && ((turn.status === "idle" && turn.id === runtimeActiveRunId)
    || turn.tools.some((tool) => tool.runId === runtimeActiveRunId && (tool.status === "running" || tool.status === "waiting")));
}

function christmasSeasonActive(now = new Date()): boolean {
  return now.getMonth() === 11 && (now.getDate() === 25
    || now.getDate() === 24 && (now.getHours() > 18 || now.getHours() === 18 && now.getMinutes() >= 30));
}

/** A delivered user step owns its quote source even inside an assistant article. */
function messageQuoteSource(markdown: Element | null | undefined): { element: HTMLElement; messageId: string } | undefined {
  const userSource = markdown?.closest<HTMLElement>('.execution-user-step[data-quote-source="user"]');
  if (userSource) {
    const messageId = userSource.dataset.quoteMessageId;
    return messageId ? { element: userSource, messageId } : undefined;
  }
  const article = markdown?.closest<HTMLElement>("article[data-message-id]");
  const messageId = article?.dataset.messageId;
  return article && messageId ? { element: article, messageId } : undefined;
}

export const MessageTimeline = memo(function MessageTimeline({ sessionId, readOnly = false, externalAgent = false, projectId, turns, skillDescriptions, skillLabels, pendingUserMessage, runtimeActiveRunId, onPreviewFile, onOpenExternal, onReferenceMessage, onShowMessageReferences, onAddQuoteToConversation, onResolvePermission, thinking, compacting = false, onRetry, onSwitchVersion, onEditRequest, editInFlight, onCreateBranch, onRollbackFiles }: MessageTimelineProps): React.JSX.Element {
  // 重试会先把目标之后的消息从视图中撤掉，再等待新回合流入；这里保留同样的乐观投影。
  // 编辑的重写投影来自 App（editInFlight），提交入口在底部输入框，不经过本组件状态。
  const [optimisticRewrite, setOptimisticRewrite] = useState<OptimisticRewrite>();
  const [quoteSelection, setQuoteSelection] = useState<{ owner: QuoteSelectionOwner; top: number; left: number }>();
  const [addingQuote, setAddingQuote] = useState(false);
  const addingQuoteRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // 关闭浮层不取消原生选区；只有新选择才重新唤起，滚动和延迟事件只更新几何。
  const dismissedQuoteSelection = useRef<{
    startContainer: Node; startOffset: number; endContainer: Node; endOffset: number; quote: string;
  } | undefined>(undefined);
  const dismissQuoteSelection = useCallback((): void => {
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined;
    dismissedQuoteSelection.current = range ? {
      startContainer: range.startContainer, startOffset: range.startOffset,
      endContainer: range.endContainer, endOffset: range.endOffset, quote: selection!.toString().trim()
    } : undefined;
    setQuoteSelection(undefined);
  }, []);
  const isDismissedQuoteSelection = useCallback((selection: Selection | null): boolean => {
    const dismissed = dismissedQuoteSelection.current;
    if (!dismissed || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return dismissed.startContainer === range.startContainer && dismissed.startOffset === range.startOffset
      && dismissed.endContainer === range.endContainer && dismissed.endOffset === range.endOffset
      && dismissed.quote === selection.toString().trim();
  }, []);
  const quoteSelectionOwnerRef = useRef<QuoteSelectionOwner | undefined>(undefined);
  const captureQuoteSelection = useCallback((): { owner: QuoteSelectionOwner; range: Range } | undefined => {
    const selection = window.getSelection();
    const timeline = timelineRef.current;
    if (readOnly || !selection || selection.isCollapsed || !selection.rangeCount || !timeline) {
      quoteSelectionOwnerRef.current = undefined;
      dismissedQuoteSelection.current = undefined;
      return;
    }
    const range = selection.getRangeAt(0);
    if (isDismissedQuoteSelection(selection)) return;
    dismissedQuoteSelection.current = undefined;
    const element = (node: Node): Element | null => node instanceof Element ? node : node.parentElement;
    const start = element(range.startContainer)?.closest(".markdown-body");
    const end = element(range.endContainer)?.closest(".markdown-body");
    const source = messageQuoteSource(start);
    const quote = selection.toString().trim();
    if (!start || start.closest(".subagent-card") || start !== end || !source || !timeline.contains(source.element)
      || !quote || quote.length > 4_000) {
      quoteSelectionOwnerRef.current = undefined;
      return;
    }
    const current = quoteSelectionOwnerRef.current;
    const owner = current?.messageId === source.messageId && current.quote === quote
      && current.startContainer === range.startContainer && current.startOffset === range.startOffset
      && current.endContainer === range.endContainer && current.endOffset === range.endOffset ? current : {
        messageId: source.messageId, quote,
        startContainer: range.startContainer, startOffset: range.startOffset,
        endContainer: range.endContainer, endOffset: range.endOffset
      };
    quoteSelectionOwnerRef.current = owner;
    return { owner, range };
  }, [isDismissedQuoteSelection, readOnly]);
  const updateQuoteSelection = useCallback((): void => {
    const selection = captureQuoteSelection();
    if (!selection) { setQuoteSelection(undefined); return; }
    const bounds = selection.range.getBoundingClientRect();
    if ((bounds.width === 0 && bounds.height === 0) || bounds.bottom < 0 || bounds.top > window.innerHeight
      || bounds.right < 0 || bounds.left > window.innerWidth) { setQuoteSelection(undefined); return; }
    const next = {
      owner: selection.owner,
      top: Math.max(8, Math.min(bounds.top - 38, window.innerHeight - 42)),
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - 124))
    };
    setQuoteSelection((current) => current?.owner === next.owner
      && Math.abs(current.top - next.top) < 1 && Math.abs(current.left - next.left) < 1 ? current : next);
  }, [captureQuoteSelection]);
  useEffect(() => {
    dismissQuoteSelection();
    let selectionTimer: number | undefined;
    const scheduleSelectionUpdate = (): void => {
      // 原生选区变化立即解除旧关闭状态；显示仍防抖，避免快速取消重选被合并成旧选区。
      if (!isDismissedQuoteSelection(window.getSelection())) dismissedQuoteSelection.current = undefined;
      // 同步观察取消和重选；120 ms 防抖只延迟显示，不能合并两轮选区的归属。
      captureQuoteSelection();
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(updateQuoteSelection, 120);
    };
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || target instanceof Element && target.closest(".message-selection-reference")) return;
      if (!timelineRef.current?.contains(target)) {
        dismissQuoteSelection();
      } else if (event.button === 0 && target instanceof Element && target.closest(".markdown-body")
        && !target.closest("a, button, input, textarea, select, [contenteditable='true']")) {
        // 主动重新拖选同一段文字，也是一轮新选择。
        dismissedQuoteSelection.current = undefined;
        quoteSelectionOwnerRef.current = undefined;
      }
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") dismissQuoteSelection(); };
    document.addEventListener("selectionchange", scheduleSelectionUpdate);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", updateQuoteSelection, true);
    window.addEventListener("resize", updateQuoteSelection);
    return () => {
      document.removeEventListener("selectionchange", scheduleSelectionUpdate);
      if (selectionTimer !== undefined) window.clearTimeout(selectionTimer);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", updateQuoteSelection, true);
      window.removeEventListener("resize", updateQuoteSelection);
    };
  }, [captureQuoteSelection, dismissQuoteSelection, isDismissedQuoteSelection, projectId, sessionId, updateQuoteSelection]);

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
    && hasSubmittedUserMessage(turns, pendingUserMessage.messageId);
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

  // 临时消息和确认事件共用消息 ID、回合结构与气泡节点，确认时只更新数据。
  const visibleTurns: TimelineTurn[] = pendingUserMessage && !hasRealPendingMessage
    ? [...displayedTurns, {
      id: pendingUserMessage.id,
      userMessageId: pendingUserMessage.messageId,
      user: pendingUserMessage.content,
      userAttachments: pendingUserMessage.attachments,
      assistant: "",
      reasoning: "",
      skills: [],
      status: "running",
      tools: [],
      steps: []
    }]
    : displayedTurns;
  const busy = compacting || thinking || Boolean(rewrite) || visibleTurns.some((turn) => turnIsRunning(turn, runtimeActiveRunId));
  const christmasThread = christmasSeasonActive() && visibleTurns.some((turn) => turn.assistant.includes("<--Christmas-->"));
  // 失败状态跟随对应消息，切会话、重启后仍可定位和重试。
  return (
    <div className="message-timeline" data-christmas={christmasThread ? "true" : undefined} ref={timelineRef} onMouseUp={updateQuoteSelection}>
      {visibleTurns.map((turn) => (
        turn.recoveryOnly ? <SavedMessageRecovery key={turn.id} messages={turn.savedMessages ?? []} detached /> :
        <Turn
          busy={busy}
          suppressRunStatus={compacting}
          readOnly={readOnly}
          externalAgent={externalAgent}
          pending={pendingUserMessage !== undefined && pendingUserMessage.messageId === turn.userMessageId && !hasRealPendingMessage}
          skillDescriptions={skillDescriptions}
          skillLabels={skillLabels}
          key={turn.userMessageId ?? turn.id}
          onCreateBranch={onCreateBranch}
          onEditRequest={onEditRequest}
          onPreviewFile={onPreviewFile}
          onOpenExternal={onOpenExternal}
          onReferenceMessage={onReferenceMessage}
          onShowMessageReferences={onShowMessageReferences}
          onResolvePermission={onResolvePermission}
          onRollbackFiles={onRollbackFiles}
          onRetry={onRetry}
          onRetryStart={startOptimisticRewrite}
          onRetrySettled={settleOptimisticRewrite}
          onSwitchVersion={onSwitchVersion}
          projectId={projectId}
          sessionId={sessionId}
          runtimeActiveRunId={runtimeActiveRunId}
          turn={turn}
        />
      ))}
      {compacting
        ? <CompactionStatus state={{ status: "pending", message: "正在压缩上下文" }} />
        : thinking && !visibleTurns.some((turn) => turnIsRunning(turn, runtimeActiveRunId)) ? <RunStatus /> : null}
      {!readOnly && quoteSelection ? createPortal(<button aria-label="将选中文字添加到对话" aria-busy={addingQuote} className="message-selection-reference" disabled={addingQuote} style={{ top: quoteSelection.top, left: quoteSelection.left }}
        onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (addingQuoteRef.current) return;
          addingQuoteRef.current = true;
          setAddingQuote(true);
          const owner = quoteSelection.owner;
          void onAddQuoteToConversation(owner.messageId, owner.quote).finally(() => {
            addingQuoteRef.current = false;
            setAddingQuote(false);
            setQuoteSelection((current) => current?.owner === owner ? undefined : current);
          });
        }} type="button"><Icon name="quote" size={14} />{addingQuote ? "正在添加…" : "添加到对话"}</button>, document.body) : null}
    </div>
  );
});

function SavedMessageRecovery({ messages, detached = false }: { messages: SavedQueuedMessage[]; detached?: boolean }): React.JSX.Element {
  const unknown = detached && messages.some((message) => message.targetMessageId === undefined);
  return <section className="saved-message-recovery" aria-label={unknown ? "恢复区域：原目标未知" : "已保存但未投递的消息"}>
    <h3>{unknown ? "原目标未知" : "已保存但未投递"}</h3>
    <p>以下消息已保存，尚未投递。不会自动执行。</p>
    {messages.map((message) => <div className="saved-message-recovery-entry" data-saved-message-id={message.messageId} key={message.messageId}>
      <span className="saved-message-recovery-label">{message.targetMessageId === undefined ? "原目标未知 · " : ""}{message.delivery === "steer" ? "插话" : "排队消息"}</span>
      {message.content ? <div className="saved-message-recovery-body">{message.content}</div> : null}
      {message.attachments.length ? <ul className="saved-message-recovery-attachments">{message.attachments.map((attachment) =>
        <li key={attachment.path}><span>{attachment.name}</span><code>{attachment.path}</code></li>)}</ul> : null}
    </div>)}
  </section>;
}

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
    memoryRecallDegraded: undefined,
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
  sessionId,
  busy,
  suppressRunStatus,
  readOnly,
  externalAgent,
  pending = false,
  skillDescriptions,
  skillLabels,
  projectId,
  runtimeActiveRunId,
  turn,
  onPreviewFile,
  onOpenExternal,
  onReferenceMessage,
  onShowMessageReferences,
  onResolvePermission,
  onRetry,
  onRetryStart,
  onRetrySettled,
  onSwitchVersion,
  onEditRequest,
  onCreateBranch,
  onRollbackFiles,
}: {
  sessionId?: string;
  busy: boolean;
  suppressRunStatus: boolean;
  readOnly: boolean;
  externalAgent: boolean;
  pending?: boolean;
  skillDescriptions?: ReadonlyMap<string, string>;
  skillLabels?: ReadonlyMap<string, string>;
  projectId: string;
  /** Runtime snapshot 里当前会话的活动 run；回合状态停在 idle 时以它兜底。 */
  runtimeActiveRunId?: string;
  turn: TimelineTurn;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onReferenceMessage(messageId: string): void;
  onShowMessageReferences(messageId: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(targetMessageId: string, input: string, attachments: AttachmentReference[], idempotencyKey: string): Promise<void>;
  onRetryStart(turn: TimelineTurn, mode: "retry" | "edit", user?: string): void;
  onRetrySettled(turnId: string, succeeded: boolean): void;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onEditRequest(turn: TimelineTurn): void;
  onCreateBranch?(): void;
  onRollbackFiles(turn: TimelineTurn): void;
}): React.JSX.Element {
  const running = turnIsRunning(turn, runtimeActiveRunId);
  const retryPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const retry = useCallback((): Promise<void> => {
    if (externalAgent || readOnly || running || busy) return Promise.resolve();
    const targetMessageId = turn.assistantMessageId ?? turn.userMessageId;
    if (!turn.user || !targetMessageId) return Promise.resolve();
    const existing = retryPromiseRef.current;
    if (existing) return existing;
    onRetryStart(turn, "retry");
    const pending = Promise.resolve().then(() => onRetry(targetMessageId, turn.user, turn.userAttachments ?? [], globalThis.crypto.randomUUID()));
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
  }, [busy, onRetry, onRetrySettled, onRetryStart, readOnly, externalAgent, running, turn]);
  const switchVersion = useCallback((direction: "prev" | "next"): Promise<void> => {
    if (readOnly || !turn.assistantMessageId) return Promise.resolve();
    return onSwitchVersion(turn.assistantMessageId, direction);
  }, [onSwitchVersion, readOnly, turn.assistantMessageId]);
  const canRetry = !externalAgent && !readOnly && !running && !busy && Boolean(turn.user && (turn.assistantMessageId ?? turn.userMessageId));
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
  const emptyCompletedTurn = !running && turn.status === "completed" && !turn.assistant.trim()
    && !executionSteps.some((step) => step.kind === "reasoning" && step.notice === "compaction");
  const emptyIncompleteTurn = !running && turn.status === "incomplete" && !turn.assistant.trim();
  return (
    <section className={`timeline-turn is-${turn.status}`}>
      {turn.user || turn.userAttachments?.length ? (
        <UserMessage
          content={turn.user}
          attachments={turn.userAttachments}
          messageId={turn.userMessageId}
          pending={pending}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          onCreateBranch={externalAgent || readOnly || pending ? undefined : onCreateBranch}
          onEdit={externalAgent || readOnly || pending ? undefined : () => onEditRequest(turn)}
          onOpenExternal={onOpenExternal}
          onReference={!readOnly && !pending && turn.userMessageId ? () => onReferenceMessage(turn.userMessageId!) : undefined}
          onShowReferences={!readOnly && !pending && turn.userMessageId ? () => onShowMessageReferences(turn.userMessageId!) : undefined}
          onPreviewFile={onPreviewFile}
          onRegenerate={canRetry ? retry : undefined}
          onRollbackFiles={readOnly || pending ? undefined : () => onRollbackFiles(turn)}
          projectId={projectId}
          time={turn.timestamp}
        />
      ) : null}
      {/* 运行中保留状态反馈；结束后不凭空补出助手内容。 */}
      {running || executionSteps.length > 0 || turn.assistant.trim() || completedChangedFiles.length > 0 || emptyCompletedTurn || emptyIncompleteTurn ? (
      <article className="chat-message desktop-assistant-message" data-message-id={turn.assistantMessageId} data-sender="assistant" tabIndex={-1}>
        <div className="agent-response">
        {executionSteps.length ? (
          <ExecutionTimeline
            readOnly={readOnly}
            sessionId={sessionId}
            onPreviewFile={onPreviewFile}
            onOpenExternal={onOpenExternal}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            running={running}
            steps={executionSteps}
            thinkingSeconds={turn.reasoningDurationMs !== undefined ? Math.max(1, Math.round(turn.reasoningDurationMs / 1000)) : undefined}
          />
        ) : null}
        {emptyCompletedTurn ? <div className="execution-empty-response" role="status">本轮已结束，但没有生成回复正文。</div> : null}
        {emptyIncompleteTurn ? <div className="execution-empty-response" role="status">{turn.error || "本轮未完成，尚未生成回复正文。"}</div> : null}
        {!executionSteps.some((step) => step.kind === "assistant") && turn.assistant ? <TypewriterMarkdown active={running} content={turn.assistant} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {running && !suppressRunStatus ? <RunStatus turn={turn} /> : null}
        {!running && completedChangedFiles.length > 0 ? (
          <ChangesSummary files={completedChangedFiles} onPreviewFile={onPreviewFile} />
        ) : null}

        {!running && (turn.assistant.trim() || (turn.status === "completed" && turn.tools.length > 0)) ? (
          <AssistantActions
            projectId={projectId}
            sessionId={sessionId}
            turn={turn}
            skillDescriptions={skillDescriptions}
            skillLabels={skillLabels}
            content={turn.assistant}
            finishReason={turn.finishReason}
            metrics={turnMetrics(turn)}
            onCreateBranch={externalAgent || readOnly ? undefined : onCreateBranch}
            onReference={!readOnly && turn.assistantMessageId ? () => onReferenceMessage(turn.assistantMessageId!) : undefined}
            onShowReferences={!readOnly && turn.assistantMessageId ? () => onShowMessageReferences(turn.assistantMessageId!) : undefined}
            onRegenerate={canRetry ? retry : undefined}
            onSwitchVersion={!readOnly && turn.versionCount && turn.versionCount > 1 ? switchVersion : undefined}
            runMs={turn.durationMs}
            timestamp={turn.timestamp}
            usage={turn.usage}
            versionCount={turn.versionCount}
            versionIndex={turn.versionIndex}
          />
        ) : null}


        </div>
      </article>
      ) : null}
      {turn.savedMessages?.length ? <SavedMessageRecovery messages={turn.savedMessages} /> : null}
      {!readOnly && !running && !(turn.status === "completed" && turn.tools.length > 0) && !turn.assistant.trim() && turn.versionCount && turn.versionCount > 1 && turn.versionIndex !== undefined ? (
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
}): React.JSX.Element | null {
  const { streaming } = useChatResponseSettings();
  const typed = useTypewriter(!streaming && active ? "" : content, streaming && active);
  if (!streaming && active) return null;
  return (
    <div className={active ? "with-streaming-cursor" : undefined}>
      <MarkdownContent content={typed} streaming={active || typed !== content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
    </div>
  );
});

export function ExecutionTimeline({ readOnly, keepActivitiesOpen = false,
  sessionId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
  projectId,
  running,
  steps,
  thinkingSeconds
}: {
  sessionId?: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  projectId: string;
  readOnly: boolean;
  keepActivitiesOpen?: boolean;
  running: boolean;
  steps: TimelineStep[];
  /** 轮次级思考耗时（秒）；纯思考段的「已思考 N 秒」兜底。 */
  thinkingSeconds?: number;
}): React.JSX.Element {
  const entries = groupExecutionSteps(steps);
  return (
    <div className="execution-timeline">
      {entries.map((entry, index) => {
        // 普通工具和思考聚合进活动段；委派与提问保留独立入口。
        if (Array.isArray(entry)) {
          return (
            <ActivitySegment
              key={entry[0]?.id ?? "activity-segment"}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={readOnly ? undefined : onResolvePermission}
              projectId={projectId}
              running={running && (keepActivitiesOpen || index === entries.length - 1)}
              steps={entry}
              thinkingSeconds={thinkingSeconds}
            />
          );
        }
        const step = entry;
        if (step.kind === "tool" && step.tool.tool === "Task" && !readOnly) {
          return <SubagentActivity key={step.id} tool={step.tool} projectId={projectId} sessionId={sessionId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} onResolvePermission={onResolvePermission} />;
        }
        if (step.kind === "reasoning") {
          // 上下文压缩标记渲染为独立的压缩分隔条（居中药丸）。
          if (step.notice === "compaction") {
            const notice = step.compaction ?? parseCompactionNotice(step.status);
            return <CompactionDivider count={notice.count} key={step.id} savedTokens={notice.savedTokens} summary={step.content || undefined} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />;
          }
          // 孤立思考也走活动段（纯思考段：一枚头像 + 「已思考 N 秒」）。
          return (
            <ActivitySegment
              key={step.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={readOnly ? undefined : onResolvePermission}
              projectId={projectId}
              running={running && (keepActivitiesOpen || index === entries.length - 1)}
              steps={[step]}
              thinkingSeconds={thinkingSeconds}
            />
          );
        }
        if (step.kind === "user") {
          return (
            <div className="execution-step execution-user-step user-message" data-quote-source="user" data-quote-message-id={step.messageId} key={step.id}>
              <div className="user-bubble">
                <MarkdownContent breaks content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} />
                {step.attachments?.length ? <MessageAttachments attachments={step.attachments} projectId={projectId} /> : null}
              </div>
            </div>
          );
        }
        if (step.kind === "tool" && readOnly) return <ActivitySegment key={step.id} projectId={projectId} steps={[step]} running={false} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} onResolvePermission={readOnly ? undefined : onResolvePermission} />;
        if (step.kind === "tool") return step.tool.tool === "AskUserQuestion"
          ? <UserInputCard key={`${sessionId}:${step.tool.runId}:${step.id}`} tool={step.tool} projectId={projectId} sessionId={sessionId} running={running} />
          : <SubagentActivity key={step.id} tool={step.tool} projectId={projectId} sessionId={sessionId} readOnly={readOnly} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} onResolvePermission={onResolvePermission} />;
        return <div className="execution-step execution-assistant-step" key={step.id}><TypewriterMarkdown active={running && index === entries.length - 1 && !step.completed && !step.summary} content={step.content} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /></div>;
      })}
    </div>
  );
}

/**
 * 把连续的可聚合步骤（工具调用 + 思考）收成一组；其余步骤原样保留顺序。
 *
 * 思考不把工具组切断：reasoning 步骤与相邻 tool 步骤进同一个活动段。压缩标记
 * （notice === "compaction"）、委派、提问、assistant 正文/摘要、用户插话是分组断点。
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
  if (step.kind === "tool") return step.tool.tool !== "Task" && step.tool.tool !== "AskUserQuestion";
  return step.kind === "reasoning" && step.notice !== "compaction";
}

function UserMessage({
  content,
  messageId,
  pending = false,
  hasChangedFiles,
  onCreateBranch,
  onEdit,
  onOpenExternal,
  onPreviewFile,
  onRegenerate,
  onRollbackFiles,
  onReference,
  onShowReferences,
  projectId,
  time,
  attachments
}: {
  content: string;
  messageId?: string;
  pending?: boolean;
  hasChangedFiles: boolean;
  onCreateBranch?(): void;
  onEdit?(): void;
  onOpenExternal(url: string): void;
  onPreviewFile(path: string): void;
  onRegenerate?(): Promise<void>;
  onRollbackFiles?(): void;
  onReference?(): void;
  onShowReferences?(): void;
  projectId: string;
  /** 消息时间（ISO 字符串）；存在时操作行前置 hover 揭示的日期感知时钟。 */
  time?: string;
  attachments?: AttachmentReference[];
}): React.JSX.Element {
  const [animateEntry] = useState(pending);
  // 更多菜单走 portal fixed 定位（与助手菜单共用 hook），内联渲染会把消息列表往下挤。
  const { open: menuOpen, position: menuPosition, anchorRef: moreAnchorRef, menuRef, toggle, close: closeMenu } = useAnchoredMenu({ width: 248, estimatedHeight: 196, align: "end" });
  // 发送时追加给模型的附件清单不该原样显示，拆出来渲染成附件卡片。
  const message = useMemo(() => {
    const legacy = splitAttachmentReferences(content);
    return { text: legacy.text, attachments: attachments?.length ? attachments : legacy.attachments };
  }, [attachments, content]);
  const clock = time ? <MessageClock time={Date.parse(time)} /> : null;
  return (
    <article aria-label={pending ? "发送中" : undefined} aria-busy={pending || undefined} className={`chat-message user-message${animateEntry ? " is-entering" : ""}`} data-message-id={messageId} data-sender="user" tabIndex={-1}>
      <div className="user-bubble">
        {message.text ? <MarkdownContent content={message.text} onOpenExternal={onOpenExternal} onPreviewFile={onPreviewFile} projectId={projectId} /> : null}
        {message.attachments.length ? <MessageAttachments attachments={message.attachments} projectId={projectId} /> : null}
      </div>
      <div className={`user-message-actions${menuOpen ? " is-open" : ""}`} data-time-hover-root>
        {clock}
        <CopyButton className="user-message-action" label="复制消息" size={16} value={message.text} />
        {onRegenerate ? <button aria-label="重新生成" className="user-message-action" onClick={() => { void onRegenerate(); }} title="重新生成" type="button"><Icon name="refresh" size={16} /></button> : null}
        {onEdit ? <button aria-label="编辑消息" className="user-message-action" onClick={onEdit} title="编辑消息" type="button"><Icon name="edit" size={16} /></button> : null}
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多消息操作" className="user-message-action" onClick={toggle} ref={moreAnchorRef} title="更多" type="button"><Icon name="more" size={16} /></button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div className="message-menu" data-direction={menuPosition.direction} ref={menuRef} role="menu" style={menuPosition.style}>
          <button className="message-menu-item" onClick={() => { copyText(message.text); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
          <button className="message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(message.text)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
          {onCreateBranch ? <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button> : null}
          {onReference ? <button className="message-menu-item" onClick={() => { onReference(); closeMenu(); }} role="menuitem" type="button"><Icon name="at" size={14} /><span>引用消息</span></button> : null}
          {onShowReferences ? <button className="message-menu-item" onClick={() => { onShowReferences(); closeMenu(); }} role="menuitem" type="button"><Icon name="network" size={14} /><span>查看引用来源</span></button> : null}
          {onRollbackFiles ? <button className="message-menu-item" disabled={!hasChangedFiles} onClick={() => { onRollbackFiles(); closeMenu(); }} role="menuitem" title={hasChangedFiles ? "回滚本条消息产生的文件修改" : "当前消息没有可回滚的文件修改"} type="button"><Icon name="arrow-left" size={14} /><span>回滚文件</span></button> : null}
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
function AssistantActions({ projectId, sessionId, turn, skillDescriptions, skillLabels, content, timestamp, metrics, runMs, usage, finishReason, onCreateBranch, onReference, onShowReferences, onRegenerate, onSwitchVersion, versionIndex, versionCount }: {
  projectId?: string;
  sessionId?: string;
  turn: TimelineTurn;
  skillDescriptions?: ReadonlyMap<string, string>;
  skillLabels?: ReadonlyMap<string, string>;
  content: string;
  timestamp?: string;
  metrics?: TurnMetrics;
  runMs?: number;
  usage?: SessionUsage;
  finishReason?: string;
  onCreateBranch?(): void;
  onReference?(): void;
  onShowReferences?(): void;
  onRegenerate?(): Promise<void>;
  onSwitchVersion?(direction: "prev" | "next"): Promise<void>;
  versionIndex?: number;
  versionCount?: number;
}): React.JSX.Element {
  const [traceOpen, setTraceOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const stopSpeechRef = useRef<() => void>(undefined);
  const { showTokenUsage } = useChatResponseSettings();
  const usageRows = showTokenUsage ? buildUsageDetailRows(usage, metrics ?? {}) : [];
  const optimization = summarizeToolOptimizations(turn.tools);
  if (showTokenUsage && optimization.runs) {
    usageRows.push({ key: "optimization", label: optimization.savedTokens < 0 ? "增加上下文（估算）" : "减少上下文（估算）", value: `${Math.abs(optimization.savedTokens).toLocaleString()} tokens` },
      { key: "rtk", label: "命令输出压缩", value: `${optimization.rtkTokens.toLocaleString()} tokens` },
      { key: "ptc", label: "脚本筛选与聚合", value: `${optimization.ptcTokens.toLocaleString()} tokens` });
  }
  const tone = finishReason ? finishReasonTone(finishReason) : undefined;
  // 更多菜单走 portal fixed 定位；条目数按需增减（用量/结束原因 + 分隔线），高度用于弹出方向判断。
  const menuItemCount = 5 + Number(Boolean(onReference)) + Number(Boolean(onShowReferences)) + (usageRows.length ? 1 : 0) + (finishReason ? 1 : 0) + ((usageRows.length || finishReason) ? 1 : 0);
  const { open: menuOpen, position: menuPosition, anchorRef: moreButtonRef, menuRef, toggle: toggleMenu, close: closeMenu } = useAnchoredMenu({ width: 248, estimatedHeight: menuItemCount * 28 + 8 });
  const usageItemRef = useRef<HTMLButtonElement>(null);
  const [usagePopover, setUsagePopover] = useState<{ top: number; left: number }>();
  const usageHideTimerRef = useRef<number | undefined>(undefined);
  const [copiedKind, setCopiedKind] = useState<"markdown" | "plain">();
  const [copyFailed, setCopyFailed] = useState(false);
  const [copyingKind, setCopyingKind] = useState<"markdown" | "plain">();
  const copyRequestRef = useRef<{ pending: boolean } | undefined>(undefined);
  const copyCloseTimerRef = useRef<number | undefined>(undefined);

  // 菜单或回复更换后，旧写入可以完成，但不能更新新操作的反馈或收起新菜单。
  useEffect(() => {
    setCopiedKind(undefined);
    setCopyingKind(undefined);
    setCopyFailed(false);
    return () => {
      copyRequestRef.current = undefined;
      if (copyCloseTimerRef.current !== undefined) window.clearTimeout(copyCloseTimerRef.current);
      copyCloseTimerRef.current = undefined;
    };
  }, [menuOpen, content, projectId, sessionId, turn.assistantMessageId]);

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

  // 菜单收起时悬浮卡一并复位。
  useEffect(() => {
    if (menuOpen) return;
    cancelUsageHide();
    setUsagePopover(undefined);
  }, [menuOpen, cancelUsageHide]);

  const copyAs = async (kind: "markdown" | "plain"): Promise<void> => {
    if (copyRequestRef.current?.pending) return;
    if (copyCloseTimerRef.current !== undefined) window.clearTimeout(copyCloseTimerRef.current);
    copyCloseTimerRef.current = undefined;
    const request = { pending: true };
    copyRequestRef.current = request;
    setCopyingKind(kind);
    setCopiedKind(undefined);
    setCopyFailed(false);
    const copied = await copyToClipboard(kind === "markdown" ? content : plainTextFromMarkdown(content));
    if (copyRequestRef.current !== request) return;
    request.pending = false;
    setCopyingKind(undefined);
    if (!copied) {
      setCopyFailed(true);
      return;
    }
    setCopiedKind(kind);
    copyCloseTimerRef.current = window.setTimeout(() => {
      copyCloseTimerRef.current = undefined;
      if (copyRequestRef.current !== request) return;
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
          <MessageContextMenu
            tools={turn.tools.map((tool) => tool.tool)}
            skills={turn.skills}
            selectedSkills={turn.capabilitySelection?.skills}
            skillCalls={turn.tools}
            skillLabels={skillLabels}
            descriptions={skillDescriptions}
            memoryRecallDegraded={turn.memoryRecallDegraded}
          />
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
                  <span className="finish-reason-label">结束原因</span>
                  <span className="finish-reason-value">{finishReason}</span>
                </div>
              ) : null}
              <div className="message-menu-separator" />
            </>
          ) : null}
          {hasContent ? (
            <>
              <button aria-label="复制为 Markdown" aria-busy={copyingKind === "markdown"} disabled={copyingKind !== undefined} className={`message-menu-item${copiedKind === "markdown" ? " is-success" : ""}`} onClick={() => { void copyAs("markdown"); }} role="menuitem" type="button">
                <Icon name={copiedKind === "markdown" ? "check" : "copy"} size={14} /><span>{copyingKind === "markdown" ? "正在复制…" : "复制为 Markdown"}</span>
              </button>
              <button aria-label="复制为纯文本" aria-busy={copyingKind === "plain"} disabled={copyingKind !== undefined} className={`message-menu-item${copiedKind === "plain" ? " is-success" : ""}`} onClick={() => { void copyAs("plain"); }} role="menuitem" type="button">
                <Icon name={copiedKind === "plain" ? "check" : "file-text"} size={14} /><span>{copyingKind === "plain" ? "正在复制…" : "复制为纯文本"}</span>
              </button>
            </>
          ) : null}
          {copyFailed ? <div className="message-menu-item is-static is-danger" role="alert">复制失败，请重试或手动复制</div> : null}
          <button className="message-menu-item" role="menuitem" type="button" onClick={() => { closeMenu(); setTraceOpen(true); }}><Icon name="activity" size={14} /><span>查看 Trace</span></button>
          <div className="message-menu-separator" role="separator" />
          {onCreateBranch ? <button className="message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button> : null}
          {onReference ? <button className="message-menu-item" onClick={() => { onReference(); closeMenu(); }} role="menuitem" type="button"><Icon name="at" size={14} /><span>引用消息</span></button> : null}
          {onShowReferences ? <button className="message-menu-item" onClick={() => { onShowReferences(); closeMenu(); }} role="menuitem" type="button"><Icon name="network" size={14} /><span>查看引用来源</span></button> : null}
        </div>,
        document.body
      ) : null}
      {traceOpen ? <ExecutionTraceDialog projectId={projectId} sessionId={sessionId} turn={turn} onClose={() => setTraceOpen(false)} /> : null}
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

/**
 * 消息"更多"菜单的开合与 fixed 定位：菜单通过 portal 挂到 document.body（脱离消息列表文档流，
 * 不会被滚动容器裁剪），打开时按锚点按钮的视口位置算坐标，下方放不下就向上弹；
 * 点击锚点/菜单以外、Esc、滚动或缩放窗口时收起。portal 不在组件 DOM 树内，
 * 外部点击判断必须显式比对锚点和菜单两个 ref。
 */
function useAnchoredMenu({ width, estimatedHeight, align = "start" }: { width: number; estimatedHeight: number; align?: "start" | "end" }): {
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
    const menuWidth = Math.min(width, window.innerWidth - 16);
    const left = Math.max(8, Math.min(align === "end" ? anchor.right - menuWidth : anchor.left, window.innerWidth - menuWidth - 8));
    const maxHeight = Math.max(0, (direction === "down" ? spaceBelow : anchor.top - gap) - 8);
    const style: CSSProperties = { left, width: menuWidth, maxHeight, transformOrigin: `${align === "end" ? "right" : "left"} ${direction === "down" ? "top" : "bottom"}` };
    setPosition(direction === "down"
      ? { direction, style: { ...style, top: anchor.bottom + gap } }
      : { direction, style: { ...style, bottom: window.innerHeight - anchor.top + gap } });
    setOpen(true);
  }, [open, estimatedHeight, width, align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target) || (target instanceof Element && target.closest(".message-context-submenu"))) return;
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
