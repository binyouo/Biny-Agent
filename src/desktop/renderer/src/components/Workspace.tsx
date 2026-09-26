/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import { ProjectSuggestionBanner } from "../threadBrief/ProjectSuggestionBanner.js";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection, DesktopPlanProjection, DesktopSessionLimits, DesktopSessionWriterConflict } from "../../../protocol.js";
import type { RecipeNotice, SkillExtractionCardState } from "../app/useDesktopEventBridge.js";
import { hasSubmittedUserMessage } from "../chatModel.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { desktopWorktreeView } from "../worktreePresentation.js";
import { Icon } from "./Icon.js";
import { spawnTitleDeleteDust } from "./titleDust.js";
import { ThreadResourcesButton } from "./workspace/ThreadResourcesButton.js";
import { GenerationErrorBanner } from "./chat/GenerationErrorBanner.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { RecipeReadyBanner } from "./RecipeReadyBanner.js";
import { SkillExtractionCard } from "./SkillExtractionCard.js";
import { ChatScroll } from "./workspace/ChatScroll.js";
import { PlanPanel } from "./workspace/PlanPanel.js";

/** 发送消息的临时投影；真实消息或队列接管后由 App 清掉。 */
export interface PendingPrompt {
  id: string;
  projectId: string;
  text: string;
  sessionId?: string;
  messageId: string;
}

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionIsolation?: "shared" | "worktree";
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  runtimeProjection?: DesktopRuntimeProjection;
  planProjection?: DesktopPlanProjection;
  onOpenProject(): void;
  onPreviewFile(path: string): void;
  runtimePanelOpen: boolean;
  onRuntimePanelOpenChange(open: boolean): void;
  thinking: boolean;
  running: boolean;
  /** Runtime snapshot 里当前会话的活动 run；时间线用它兜底丢了 run.started 的 live 回合。 */
  runtimeActiveRunId?: string;
  planning?: boolean;
  /** 当前会话的 Recipe 提示卡；固定在输入框上方，不随消息流滚走。 */
  recipeNotices?: RecipeNotice[];
  onDismissRecipe?(notice: RecipeNotice): void;
  onExtractRecipe?(notice: RecipeNotice): void;
  /** 技能提取（自进化）进度卡；与 Recipe 卡同区域，run.started 后由事件桥清除。 */
  skillExtraction?: SkillExtractionCardState;
  onDismissSkillExtraction?(): void;
  onOpenExternal(url: string): void;
  onReferenceMessage(messageId: string): void;
  onShowMessageReferences(messageId: string): void;
  onCaptureQuote(messageId: string, quote: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(targetMessageId: string, input: string, idempotencyKey: string): Promise<void>;
  onSwitchVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  onRetryWriterConflict(): Promise<void>;
  writerConflict?: DesktopSessionWriterConflict;
  /** 会话体量接近持久化上限时的预警信息；未接近时缺省。 */
  sessionLimits?: DesktopSessionLimits;
  /** 点「编辑」用户消息：文本回填到底部输入框。 */
  onEditRequest(turn: TimelineTurn): void;
  /** 进行中的编辑重写投影；提交与清除都由 App 负责。 */
  editInFlight?: { turnId: string; user: string; userMessageIndex?: number };
  /** 当前要展示的生成错误文本（由实时失败事件驱动）；空值 = 不展示。 */
  generationError?: string;
  onDismissGenerationError(): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
  /** 顶栏的项目/分支选择器胶囊（含菜单），由 App 装配；无项目时缺省。 */
  workspaceContext?: React.ReactNode;
  /** 工具入口与按产出显示的右上角资源按钮相互独立。 */
  inspectorRail?: React.ReactNode;
  /** 发送消息的临时投影；真实事件到达后由 App 清掉。 */
  pendingPrompt?: PendingPrompt;
  skillDescriptions?: ReadonlyMap<string, string>;
  /** 顶部工具条：自动化/技能入口（搜索与新建任务在侧栏 chrome）。 */
  onOpenRuntime(): void;
  onOpenExtensions(): void;
  children?: React.ReactNode;
}

export function Workspace({
  project,
  projectId,
  sessionId,
  sessionTitle,
  sessionIsolation,
  turns,
  loading,
  runtimeError,
  runtimeProjection,
  planProjection,
  onOpenProject,
  onPreviewFile,
  runtimePanelOpen,
  onRuntimePanelOpenChange,
  thinking,
  running,
  runtimeActiveRunId,
  planning,
  recipeNotices,
  skillExtraction,
  onDismissSkillExtraction,
  onDismissRecipe,
  onExtractRecipe,
  onOpenExternal,
  onReferenceMessage,
  onShowMessageReferences,
  onCaptureQuote,
  onResolvePermission,
  onRetry,
  onSwitchVersion,
  onRetryWriterConflict,
  writerConflict,
  sessionLimits,
  onEditRequest,
  editInFlight,
  generationError,
  onDismissGenerationError,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  pendingPrompt,
  skillDescriptions,
  workspaceContext,
  inspectorRail,
  onOpenRuntime: _onOpenRuntime,
  onOpenExtensions: _onOpenExtensions,
  children
}: WorkspaceProps): React.JSX.Element {
  const visiblePendingPrompt = pendingPrompt && pendingPrompt.projectId === projectId
    && (pendingPrompt.sessionId === undefined || pendingPrompt.sessionId === sessionId)
    && !hasSubmittedUserMessage(turns, pendingPrompt.messageId)
    ? pendingPrompt
    : undefined;
  const streaming = running || visiblePendingPrompt !== undefined || turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  const lastTurn = turns.at(-1);
  // 上限预警按会话 dismiss：换会话要重新提示，同会话点掉后不再打扰。
  const [limitBannerDismissedFor, setLimitBannerDismissedFor] = useState<string>();
  const showLimitBanner = Boolean(sessionLimits?.nearSizeLimit && sessionId && limitBannerDismissedFor !== sessionId);
  // 标题栏底缘阴影跟随聊天区滚动（参考应用 showBottomShadow：离开顶部时才出现）。
  const [chatScrolled, setChatScrolled] = useState(false);
  const selectedWorktree = sessionId === undefined
    ? undefined
    : runtimeProjection?.worktrees.find((worktree) => worktree.sessionId === sessionId);
  const worktreeView = sessionIsolation === "worktree" ? desktopWorktreeView(selectedWorktree) : undefined;
  const hasConversation = (turns.length > 0 || streaming) && Boolean(projectId);
  // 首条提交的上浮 FLIP：pending 投影出现且上一帧还没有会话内容时置位一次，
  // 气泡从输入框位置上浮到时间线槽位（起点在 MessageTimeline 内实时解析）。
  const [prevHadConversation, setPrevHadConversation] = useState(false);
  const pendingFloatFromComposer = visiblePendingPrompt !== undefined && !prevHadConversation;
  useEffect(() => {
    setPrevHadConversation(hasConversation);
  }, [hasConversation]);

  return (
    <div className="workspace biny-workspace biny-workspace-chat">
      <div className="biny-workspace-main">
        {runtimePanelOpen ? null : inspectorRail}
        <header className={`biny-chat-toolbar${chatScrolled ? " is-scrolled" : ""}`}>
          <div className="biny-chat-drag-region">
            {/* 顶栏：会话名截断展示（生成中呼吸 + 生成中的标题更新走删字+打字机 + 2×2 工作点阵）；
              项目/分支胶囊与隔离工作树指示跟随标题排在同一行。标题组件按会话重建：
              切换会话直接呈现新标题，不把旧标题「删字+重打」一遍，否则动画期间标题宽度
              逐帧收缩/增长，会把右侧胶囊一直来回拉伸。 */}
            {sessionTitle || !project ? (
              <div className="biny-chat-title">
                {sessionTitle ? (
                  <ThreadTitleText key={sessionId} running={streaming} title={sessionTitle} />
                ) : (
                  <>
                    <strong>Biny</strong>
                    {!project ? <span>打开一个本地项目开始</span> : null}
                  </>
                )}
                {/* 生成中的 2×2 工作点阵（working-dot-grid 原文，错相闪烁）。 */}
                {streaming && sessionTitle ? (
                  <span aria-hidden="true" className="working-dot-grid">
                    <span /><span /><span /><span />
                  </span>
                ) : null}
              </div>
            ) : null}
            {workspaceContext}
            {worktreeView ? (
              <button
                aria-label={`隔离工作树：${worktreeView.label}。${worktreeView.detail}`}
                className={`biny-worktree-indicator is-${worktreeView.tone}`}
                onClick={() => onRuntimePanelOpenChange(true)}
                title={`${worktreeView.label}：${worktreeView.detail}`}
                type="button"
              >
                <Icon name="folder-open" size={13} />
                <span>隔离工作树</span>
                <small>{worktreeView.label}</small>
              </button>
            ) : null}
          </div>
          <div className="biny-chat-actions">
            <ThreadResourcesButton key={`${projectId}:${sessionId}`} turns={turns} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
          </div>
        </header>
        <RuntimePanel
          onClose={() => onRuntimePanelOpenChange(false)}
          onError={onRuntimeError}
          onMutation={onRuntimeMutation}
          onRefresh={onRuntimeRefresh}
          open={runtimePanelOpen}
          projection={runtimeProjection}
          selectedSessionId={sessionId}
          worktreeSession={sessionIsolation === "worktree"}
        />
        <div className="biny-chat-body">
          {showLimitBanner && sessionLimits && sessionId ? (
            <div className="biny-session-limit-banner" role="status">
              <span>
                这个会话已写入 {(sessionLimits.sizeBytes / 1048576).toFixed(1)} MB / {Math.round(sessionLimits.maxSizeBytes / 1048576)} MB（{sessionLimits.eventCount.toLocaleString()} 个事件）。
                越大打开和回放越慢，建议分叉出新会话继续。
              </span>
              <button onClick={onCreateBranch} type="button">分叉新会话</button>
              <button aria-label="忽略" className="biny-session-limit-dismiss" onClick={() => setLimitBannerDismissedFor(sessionId)} type="button">×</button>
            </div>
          ) : null}
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : hasConversation && projectId ? (
            <ChatScroll onScrolledChange={setChatScrolled} sessionId={sessionId} streaming={streaming}>
              <MessageTimeline
                sessionId={sessionId}
                onCreateBranch={onCreateBranch}
                onDeleteUserMessage={onDeleteUserMessage}
                editInFlight={editInFlight}
                onEditRequest={onEditRequest}
                onOpenExternal={onOpenExternal}
                onReferenceMessage={onReferenceMessage}
                onShowMessageReferences={onShowMessageReferences}
                onCaptureQuote={onCaptureQuote}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                onRollbackFiles={onRollbackFiles}
                onRetry={onRetry}
                onSwitchVersion={onSwitchVersion}
                pendingUserMessage={visiblePendingPrompt
                  ? { id: visiblePendingPrompt.id, messageId: visiblePendingPrompt.messageId, content: visiblePendingPrompt.text }
                  : undefined}
                pendingFloatFromComposer={pendingFloatFromComposer}
                runtimeActiveRunId={runtimeActiveRunId}
                skillDescriptions={skillDescriptions}
                thinking={streaming || thinking}
                projectId={projectId}
                turns={turns}
              />
            </ChatScroll>
          ) : (
            <div className="biny-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        <div className={`biny-chat-composer${visiblePendingPrompt && turns.length === 0 ? " is-entering" : ""}`}>
            {sessionId && !writerConflict ? <PlanPanel sessionId={sessionId} planning={planning === true} busy={running} projection={planProjection} onMutation={onRuntimeMutation} onError={onRuntimeError} /> : null}
            {recipeNotices && recipeNotices.length > 0 && projectId ? (
              <div className="biny-recipe-ready-notices">
                <RecipeReadyBanner
                  notice={recipeNotices[0]!}
                  onDismiss={(notice) => onDismissRecipe?.(notice)}
                  onExtract={(notice) => onExtractRecipe?.(notice)}
                />
              </div>
            ) : null}
            <ProjectSuggestionBanner key={sessionId} sessionId={sessionId} />
            {skillExtraction ? <SkillExtractionCard state={skillExtraction} onDismiss={() => onDismissSkillExtraction?.()} /> : null}
            {generationError ? (
              <GenerationErrorBanner error={generationError} model={generationError === lastTurn?.error ? lastTurn?.model?.label : undefined} onDismiss={onDismissGenerationError} />
            ) : null}
            {writerConflict ? <SessionWriterConflictBanner onRetry={onRetryWriterConflict} /> : children}
        </div>
      </div>
      {streaming ? <span className="biny-streaming-state" aria-hidden="true" /> : null}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="biny-status-state" role="status"><ThinkingOrb aria-label="正在恢复会话" className="thinking-orb" size={20} state="connecting" theme="auto" /><span>正在恢复会话…</span></div>;
}

/* ---- 标题打字机（参考应用 ThreadTitle 原文逻辑移植） ----
 * 生成中先进入 thinking 呼吸（thread-title-thinking，标题栏内禁用扫光改用呼吸）；
 * 生成中的标题更新走「删字 → 打字」两段打字机：删字 85ms/字符 easeInQuart、打字 95ms/字符
 * easeOutQuart，光标带 shrink/grow 拖尾（.thread-title-caret.trail-*），思考态最短保持 500ms；
 * 删掉的字符在标题右缘喷尘粒（titleDust.ts，原文 spawnTitleDeleteDust 移植）。
 * 动画只在生成中播放；非生成中的标题变化（切会话等）直接同步，见下方标题变化 effect。 */

const CHAR_DELETE_DELAY = 85;
const CHAR_TYPE_DELAY = 95;
const THINKING_MIN_DURATION = 500;

const easeInQuart = (t: number): number => t * t * t * t;
const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);

type TitlePhase = "idle" | "thinking" | "deleting" | "typing";

function ThreadTitleText({ running, title }: { running: boolean; title: string }): React.JSX.Element {
  const [displayText, setDisplayText] = useState(title);
  const [phase, setPhase] = useState<TitlePhase>("idle");
  const [caretVisible, setCaretVisible] = useState(false);
  const [trailDirection, setTrailDirection] = useState<"shrink" | "grow" | null>(null);
  const [caretPosition, setCaretPosition] = useState(0);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const thinkStartRef = useRef(0);
  const pendingTitleRef = useRef<string | null>(null);
  // 打字机闭包需要读「当前已展示文本」；动画结束接续队列时用它而不是 state。
  const displayTextRef = useRef(title);
  useEffect(() => {
    displayTextRef.current = displayText;
  }, [displayText]);

  useEffect(() => {
    if (running && phase === "idle") {
      setPhase("thinking");
      thinkStartRef.current = Date.now();
    }
  }, [running, phase]);

  // 光标贴在当前文本右缘（原文：textRef.offsetLeft + offsetWidth）。
  useLayoutEffect(() => {
    if (textRef.current && caretVisible) {
      setCaretPosition(textRef.current.offsetLeft + textRef.current.offsetWidth);
    }
  }, [displayText, caretVisible]);

  useEffect(() => () => {
    if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
  }, []);

  const animateTypewriter = (fromText: string, toText: string, onComplete: () => void): void => {
    const deleteLength = fromText.length;
    const typeLength = toText.length;
    const totalDeleteTime = deleteLength * CHAR_DELETE_DELAY;
    const totalTypeTime = typeLength * CHAR_TYPE_DELAY;
    let startTime: number | null = null;
    let currentPhase: "deleting" | "typing" = "deleting";
    let lastCharsToShow = fromText.length;
    setCaretVisible(true);
    setTrailDirection("shrink");
    const animate = (timestamp: number): void => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      if (currentPhase === "deleting") {
        const progress = Math.min(elapsed / totalDeleteTime, 1);
        const charsToShow = Math.round(deleteLength * (1 - easeInQuart(progress)));
        if (charsToShow !== lastCharsToShow) {
          // 删掉的字符喷尘粒（幽灵文本 + 尘点，原文 spawnTitleDeleteDust）。
          if (textRef.current && containerRef.current) {
            spawnTitleDeleteDust(textRef.current, containerRef.current, fromText.slice(charsToShow, lastCharsToShow));
          }
          lastCharsToShow = charsToShow;
          setDisplayText(fromText.slice(0, charsToShow));
        }
        if (progress >= 1) {
          currentPhase = "typing";
          startTime = timestamp;
          lastCharsToShow = 0;
          setPhase("typing");
          setTrailDirection("grow");
        }
      } else {
        const progress = Math.min(elapsed / totalTypeTime, 1);
        const charsToShow = Math.round(typeLength * easeOutQuart(progress));
        if (charsToShow !== lastCharsToShow) {
          lastCharsToShow = charsToShow;
          setDisplayText(toText.slice(0, charsToShow));
        }
        if (progress >= 1) {
          setCaretVisible(false);
          setTrailDirection(null);
          onComplete();
          return;
        }
      }
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // 打字机收尾：有排队标题就链式再来一轮，否则回到 idle。
  const finishTypewriter = (): void => {
    const queued = pendingTitleRef.current;
    if (queued !== null && queued !== displayTextRef.current) {
      pendingTitleRef.current = null;
      setPhase("deleting");
      animateTypewriter(displayTextRef.current, queued, finishTypewriter);
      return;
    }
    pendingTitleRef.current = null;
    setPhase("idle");
  };

  // 标题变化：生成中的更新走打字机；非生成中的变化（切换会话、流结束后迟到的标题事件）
  // 直接同步展示。动画期间标题宽度逐帧收缩/增长，会把同一行的项目胶囊一直来回拉伸，
  // 因此 idle 态一律不播，若还有动画在播也一并取消。
  useEffect(() => {
    if (title === displayTextRef.current || pendingTitleRef.current === title) return;
    if (!running) {
      if (animationFrameRef.current !== undefined) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = undefined;
      }
      pendingTitleRef.current = null;
      setCaretVisible(false);
      setTrailDirection(null);
      setPhase("idle");
      setDisplayText(title);
      return;
    }
    pendingTitleRef.current = title;
    if (phase === "deleting" || phase === "typing") return;
    const elapsed = phase === "thinking" ? Date.now() - thinkStartRef.current : THINKING_MIN_DURATION;
    const timer = window.setTimeout(() => {
      const target = pendingTitleRef.current;
      pendingTitleRef.current = null;
      if (target === null || target === displayTextRef.current) {
        setPhase("idle");
        return;
      }
      setPhase("deleting");
      animateTypewriter(displayTextRef.current, target, finishTypewriter);
    }, Math.max(0, THINKING_MIN_DURATION - elapsed));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只对标题与生成状态变化触发；展示文本与 phase 经 ref/动画状态读取
  }, [title, running]);

  // 结束生成且没有待处理标题时退出呼吸。
  useEffect(() => {
    if (!running && pendingTitleRef.current === null && phase === "thinking") setPhase("idle");
  }, [running, phase]);

  return (
    <span
      className={`biny-thread-title${phase === "thinking" ? " thread-title-thinking" : ""}`}
      ref={containerRef}
    >
      <span className="biny-thread-title-text" ref={textRef}>{displayText || "\u200B"}</span>
      {caretVisible ? (
        <span
          className={`thread-title-caret${trailDirection === "shrink" ? " trail-shrink" : ""}${trailDirection === "grow" ? " trail-grow" : ""}`}
          style={{ transform: `translateX(${String(caretPosition)}px)` }}
        />
      ) : null}
    </span>
  );
}

function RuntimeError({ error, onOpenProject }: { error: string; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="biny-runtime-error" role="alert">
      <Icon name="warning" size={22} />
      <h2>Agent Runtime 无法启动</h2>
      <p>{error}</p>
      <small>若另一个 Biny/CLI 会话正在占用项目，请先退出该会话；其他错误请检查共享配置后重试。</small>
      <button onClick={onOpenProject} type="button">打开其他项目</button>
    </div>
  );
}

function SessionWriterConflictBanner({ onRetry }: { onRetry(): Promise<void> }): React.JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const retry = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div aria-live="polite" className="biny-session-writer-conflict" role="alert">
      <Icon name="lock" size={17} />
      <div className="biny-session-writer-conflict-copy">
        <strong>已在另一个应用中打开</strong>
        <span>请先在那边关闭会话，才能在这里继续。</span>
      </div>
      <button disabled={retrying} onClick={() => void retry()} type="button">{retrying ? "重试中…" : "重试"}</button>
    </div>
  );
}
