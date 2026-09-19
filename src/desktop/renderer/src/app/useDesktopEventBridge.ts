/**
 * Desktop Agent 事件桥。
 *
 * 主进程为所有项目共用一条事件通道。本 hook 负责按帧批处理、按项目/会话过滤、刷新终态快照，
 * 并把结果写回 React 状态；组件无需理解事件时序或处理流式输出的高频更新。
 */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ContextBudgetStatus } from "../../../../agent/context/types.js";
import { isTerminalRunEvent, type AgentHostEvent } from "../../../../runtime/agentEvents.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopSessionDocument,
  DesktopSessionWriterConflict,
  DesktopSessionSummary,
  DesktopRecipeSuggestion,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";
import { liveTimelineEvents } from "../sessionTimeline.js";
import { applyUpdatesToSidebarSessions, applyUpdatesToWorkspace, hasContextStatus } from "./desktopState.js";

/** 聊天内 Recipe 提示卡的数据；从 `recipe.ready` host event 提取。 */
export interface RecipeNotice extends DesktopRecipeSuggestion {
  sessionId: string;
}

/** 技能提取卡状态；同一会话同时只有一个提取在跑，阶段事件直接覆盖。 */
export interface SkillExtractionCardState {
  sessionId: string;
  stage: "extracting" | "saving" | "done";
  skillName?: string;
  skillDescription?: string;
  updated?: boolean;
}

interface DesktopEventBridgeOptions {
  onRuntimeProjectionChanged?(): Promise<void>;
  activeProjectIdRef: { current: string | undefined };
  selectedSessionIdRef: { current: string | undefined };
  /** 当前会话文档；判断 pending 缓冲是否已被 openSession 的主进程桶覆盖时读取。 */
  documentRef: RefObject<DesktopSessionDocument | undefined>;
  mergeProjectSnapshot(snapshot: DesktopWorkspaceSnapshot): void;
  onError(error: unknown): void;
  setContextBudget: Dispatch<SetStateAction<ContextBudgetStatus | undefined>>;
  setDocument: Dispatch<SetStateAction<DesktopSessionDocument | undefined>>;
  /** 收集当前选中会话的 Recipe 通知；事件不进消息时间线，只驱动聊天内提示卡。 */
  setRecipeNotices: Dispatch<SetStateAction<RecipeNotice[]>>;
  /** 技能提取（自进化）进度卡；run.started 时清除，不进消息时间线。 */
  setSkillExtraction: Dispatch<SetStateAction<SkillExtractionCardState | undefined>>;
  setWriterConflict: Dispatch<SetStateAction<DesktopSessionWriterConflict | undefined>>;
  setSidebarSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>;
  setWorkspace: Dispatch<SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
  /** 当前会话新一轮生成开始（run.started）：清掉生成错误横幅。 */
  onGenerationStarted(): void;
  /** 当前会话生成失败（run.failed / run.incomplete / run.blocked）：弹出输入框上方的错误横幅。 */
  onGenerationError(message: string): void;
}

export function useDesktopEventBridge({
  onRuntimeProjectionChanged,
  activeProjectIdRef,
  selectedSessionIdRef,
  mergeProjectSnapshot,
  onError,
  setContextBudget,
  setDocument,
  setRecipeNotices,
  setSkillExtraction,
  setWriterConflict,
  setSidebarSessions,
  setWorkspace,
  onGenerationStarted,
  onGenerationError
}: DesktopEventBridgeOptions): void {
  useEffect(() => {
    const eventQueue: DesktopAgentEventEnvelope[] = [];
    const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let eventFrame: number | undefined;

    const scheduleRefresh = (projectId: string, sessionId: string): void => {
      const existing = refreshTimers.get(projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        refreshTimers.delete(projectId);
        void window.biny.refreshProject(projectId).then(async (snapshot) => {
          mergeProjectSnapshot(snapshot);
          if (activeProjectIdRef.current === projectId && selectedSessionIdRef.current === sessionId) {
            const refreshedDocument = await window.biny.openSession(projectId, sessionId);
            if (activeProjectIdRef.current === projectId && selectedSessionIdRef.current === sessionId) {
              setDocument(refreshedDocument);
              setWriterConflict(refreshedDocument.writerConflict);
            }
          }
        }).catch(onError);
      }, 260);
      refreshTimers.set(projectId, timer);
    };

    const flushEvents = (): void => {
      eventFrame = undefined;
      const batch = eventQueue.splice(0);
      if (!batch.length) return;
      setSidebarSessions((current) => applyUpdatesToSidebarSessions(current, batch));
      const activeProjectId = activeProjectIdRef.current;
      const projectBatch = activeProjectId
        ? batch.filter((envelope) => envelope.projectId === activeProjectId)
        : [];
      if (projectBatch.length) {
        if (projectBatch.some(({ event }) => !event || event.type === "tool.completed" || event.type === "tool.failed" || isTerminalRunEvent(event))) {
          void onRuntimeProjectionChanged?.().catch(onError);
        }
        setWorkspace((current) => current && current.project.id === activeProjectId
          ? applyUpdatesToWorkspace(current, projectBatch)
          : current);
        const currentSessionId = selectedSessionIdRef.current;
        const currentEvents: AgentHostEvent[] = [];
        // 头部事件可能先于会话选中到达（草稿首发时 message.user / run.started 先于 receipt）：
        // 未命中当前会话的事件按会话暂存，不能丢——historicalPrefix 依赖这些锚点截断历史。
        // 会话选中后，文档还是空占位时原序回放缓冲；文档已带该会话内容（openSession 的
        // 主进程桶是超集）则整体作废，避免同一批事件被折叠两次。
        for (const envelope of projectBatch) {
          const event = envelope.event;
          if (event === undefined) continue;
          if (currentSessionId !== undefined && event.sessionId === currentSessionId) currentEvents.push(event);
          else if (event.sessionId !== undefined) pendingEvents.hold(event.sessionId, envelope);
        }
        if (currentSessionId) {
          const doc = documentRef.current;
          if (doc?.session.id === currentSessionId && (doc.events.length > 0 || doc.liveEvents.length > 0)) {
            pendingEvents.take(currentSessionId, true);
          } else if (doc?.session.id === currentSessionId && doc.events.length === 0 && doc.liveEvents.length === 0) {
            const drained = pendingEvents.take(currentSessionId)
              .map((envelope) => envelope.event)
              .filter((event): event is AgentHostEvent => event !== undefined);
            currentEvents.unshift(...drained);
          }
          // recipe.ready / skill_extraction.updated 是提示通知而非对话内容：
          // 不进消息时间线，分别驱动聊天内卡片。
          const recipeNotices = currentEvents.filter((event) => event.type === "recipe.ready");
          if (recipeNotices.length) {
            setRecipeNotices((current) => {
              const seen = new Set(current.map((notice) => notice.id));
              const fresh = recipeNotices
                .filter((event) => !seen.has(event.recipe.id))
                .map((event) => ({ ...event.recipe, sessionId: currentSessionId }));
              return fresh.length ? [...current, ...fresh] : current;
            });
          }
          for (const event of currentEvents) {
            if (event.type === "skill_extraction.updated") {
              setSkillExtraction({
                sessionId: currentSessionId,
                stage: event.stage,
                skillName: event.skillName,
                skillDescription: event.skillDescription,
                updated: event.updated
              });
            }
          }
          const timelineSource = recipeNotices.length || currentEvents.some((event) => event.type === "skill_extraction.updated")
            ? currentEvents.filter((event) => event.type !== "recipe.ready" && event.type !== "skill_extraction.updated")
            : currentEvents;
          const timelineEvents = liveTimelineEvents(timelineSource);
          if (timelineEvents.length) {
            setDocument((current) => current?.session.id === currentSessionId
              ? { ...current, liveEvents: [...current.liveEvents, ...timelineEvents] }
              : current);
          }
          const contextEvents = currentEvents.filter(hasContextStatus);
          const latestContext = contextEvents.at(-1);
          if (latestContext) setContextBudget(latestContext.context.budget);
          // 按事件顺序更新瞬态提示，确保同一批中后开始的运行清掉前一轮失败。
          for (const event of currentEvents) {
            if (event.type === "run.started") {
              onGenerationStarted();
              // 新一轮开始：上一轮的技能提取卡退场。
              setSkillExtraction(undefined);
            }
            if (event.type === "run.failed") onGenerationError(event.error.trim() || "生成失败，请重试。");
            if (event.type === "run.incomplete" || event.type === "run.blocked") onGenerationError(event.reason.trim() || "生成失败，请重试。");
          }
        }
      }

      const completedProjects = new Map<string, string>();
      for (const envelope of batch) {
        const event = envelope.event;
        if (event && (isTerminalRunEvent(event) || event.type === "session.title")) {
          completedProjects.set(envelope.projectId, event.sessionId);
        }
      }
      for (const [projectId, sessionId] of completedProjects) scheduleRefresh(projectId, sessionId);
    };

    const unsubscribe = window.biny.onAgentEvent((envelope) => {
      eventQueue.push(envelope);
      eventFrame ??= window.requestAnimationFrame(flushEvents);
    });
    return () => {
      unsubscribe();
      if (eventFrame !== undefined) window.cancelAnimationFrame(eventFrame);
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
    };
  }, [activeProjectIdRef, documentRef, mergeProjectSnapshot, onError, selectedSessionIdRef, setContextBudget, setDocument, setRecipeNotices, setSkillExtraction, setSidebarSessions, setWorkspace, setWriterConflict, onGenerationError, onGenerationStarted, onRuntimeProjectionChanged]);
}
