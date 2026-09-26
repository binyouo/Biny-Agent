/**
 * Desktop 渲染端的纯状态投影。
 *
 * 这里只处理 IPC 快照、实时事件和会话文档之间的合并，不订阅事件、不调用 IPC，也不包含
 * React 状态。把这些规则集中后，App 与事件桥都不需要各自推算项目、会话和运行状态。
 */
import type { ContextStatus } from "../../../../agent/context/types.js";
import type { ModelRuntimeInfo } from "../../../../llm/ModelManager.js";
import { isTerminalRunEvent, type AgentHostEvent } from "../../../../runtime/agentEvents.js";
import type { SessionEvent } from "../../../../session/recorder.js";
import { publicUserMessage } from "../../../../session/publicMessage.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";

export function applyUpdatesToWorkspace(
  workspace: DesktopWorkspaceSnapshot,
  updates: DesktopAgentEventEnvelope[]
): DesktopWorkspaceSnapshot {
  const projectUpdates = updates.filter((update) => update.projectId === workspace.project.id);
  const sessions = applyUpdatesToProjectSessions(workspace.project.id, workspace.sessions, projectUpdates);
  // 并行池化后一个项目有多个 runtime 在推送：workspace.runtime 只跟随主 runtime（primary !== false），
  // 各会话的运行态按信封上的 sessionId 存进 sessionRuntimes。
  const runtime = projectUpdates.filter((update) => update.primary !== false).at(-1)?.snapshot ?? workspace.runtime;
  let sessionRuntimes = workspace.sessionRuntimes;
  let previousPrimarySnapshot = workspace.runtime;
  for (const update of projectUpdates) {
    const snapshot = update.snapshot;
    if (!snapshot) continue;
    // resume/startDraft 会先以旧 session 发布 maintenance，再以新 session 发布 idle。
    // 这是同一个主 runtime 的换绑过程，旧条目不能继续被全局忙碌判断计入；只在
    // maintenance → 新 session idle 的闭合转换时清理，避免误删并行 Host 中仍在运行的会话。
    if (
      update.primary !== false
      && snapshot.state.kind === "idle"
      && previousPrimarySnapshot?.state.kind === "maintenance"
      && previousPrimarySnapshot.info.sessionId !== snapshot.info.sessionId
      && sessionRuntimes?.[previousPrimarySnapshot.info.sessionId] === previousPrimarySnapshot
    ) {
      const nextSessionRuntimes = { ...sessionRuntimes };
      delete nextSessionRuntimes[previousPrimarySnapshot.info.sessionId];
      sessionRuntimes = nextSessionRuntimes;
    }
    const sessionId = update.sessionId ?? snapshot.info.sessionId;
    if (sessionId) sessionRuntimes = { ...sessionRuntimes, [sessionId]: snapshot };
    if (update.primary !== false) previousPrimarySnapshot = snapshot;
  }
  return {
    ...workspace,
    sessions,
    runtime,
    sessionRuntimes,
    // 权限模式来自共享持久化配置；Runtime 快照可能仍是旧 Host 的内存状态，不能反向覆盖它。
    permissionMode: workspace.permissionMode
  };
}

/** 文本/思考增量不会改变任务摘要，先过滤再扫描会话列表。 */
function affectsSidebarSession(event: AgentHostEvent | undefined): boolean {
  return event !== undefined && (event.type === "message.user" || event.type === "run.started"
    || event.type === "permission.requested" || event.type === "permission.resolved" || isTerminalRunEvent(event));
}

/** 把所有项目共用的事件流投影到侧栏任务摘要，并保留未受影响项目的任务。 */
export function applyUpdatesToSidebarSessions(
  sessions: DesktopSessionSummary[],
  updates: DesktopAgentEventEnvelope[]
): DesktopSessionSummary[] {
  const relevantUpdates = updates.filter((update) => affectsSidebarSession(update.event));
  if (!relevantUpdates.length) return sessions;
  const sessionsByProject = new Map<string, DesktopSessionSummary[]>();
  for (const session of sessions) {
    const group = sessionsByProject.get(session.projectId) ?? [];
    group.push(session);
    sessionsByProject.set(session.projectId, group);
  }
  const updatesByProject = new Map<string, DesktopAgentEventEnvelope[]>();
  for (const update of relevantUpdates) {
    const group = updatesByProject.get(update.projectId) ?? [];
    group.push(update);
    updatesByProject.set(update.projectId, group);
  }
  let changed = false;
  for (const [projectId, projectUpdates] of updatesByProject) {
    const current = sessionsByProject.get(projectId) ?? [];
    const next = applyUpdatesToProjectSessions(projectId, current, projectUpdates);
    if (next !== current) { changed = true; sessionsByProject.set(projectId, next); }
  }
  return changed ? [...sessionsByProject.values()].flat() : sessions;
}

/** 用项目快照中的完整任务列表替换侧栏里该项目的旧投影。 */
export function replaceProjectSessions(
  sessions: DesktopSessionSummary[],
  projectId: string,
  projectSessions: DesktopSessionSummary[]
): DesktopSessionSummary[] {
  const firstProjectIndex = sessions.findIndex((session) => session.projectId === projectId);
  const remaining = sessions.filter((session) => session.projectId !== projectId);
  const insertAt = firstProjectIndex < 0 ? remaining.length : Math.min(firstProjectIndex, remaining.length);
  return [
    ...remaining.slice(0, insertAt),
    ...[...projectSessions].sort(sessionSort),
    ...remaining.slice(insertAt)
  ];
}

/** 把懒加载得到的某一页并入侧栏；不触碰尚未重新读取的兄弟节点。 */
export function mergeProjectSessionPage(
  sessions: DesktopSessionSummary[],
  projectId: string,
  pageSessions: DesktopSessionSummary[]
): DesktopSessionSummary[] {
  const projectSessions = new Map(
    sessions.filter((session) => session.projectId === projectId).map((session) => [session.id, session])
  );
  for (const session of pageSessions) {
    const existing = projectSessions.get(session.id);
    // 打开会话返回的是单会话快照，不为此再扫描整个 catalog/run ledger 推断列表字段；
    // 保留首屏已有的展开状态和 latestRun，避免一次打开把侧栏能力投影误清掉。
    projectSessions.set(
      session.id,
      existing !== undefined && (session.hasChildren === undefined || session.latestRun === undefined)
        ? {
            ...session,
            hasChildren: session.hasChildren ?? existing.hasChildren,
            latestRun: session.latestRun ?? existing.latestRun
          }
        : session
    );
  }
  const firstProjectIndex = sessions.findIndex((session) => session.projectId === projectId);
  const remaining = sessions.filter((session) => session.projectId !== projectId);
  const insertAt = firstProjectIndex < 0 ? remaining.length : Math.min(firstProjectIndex, remaining.length);
  return [
    ...remaining.slice(0, insertAt),
    ...[...projectSessions.values()].sort(sessionSort),
    ...remaining.slice(insertAt)
  ];
}

/** 快照刷新根页时替换根节点，但保留已经展开并加载的子树。 */
export function replaceProjectSessionRoots(
  sessions: DesktopSessionSummary[],
  projectId: string,
  rootSessions: DesktopSessionSummary[],
  allProjectSessions: DesktopSessionSummary[]
): DesktopSessionSummary[] {
  const firstProjectIndex = sessions.findIndex((session) => session.projectId === projectId);
  const existingSessionIds = new Set(
    allProjectSessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id)
  );
  const childSessions = sessions.filter((session) => (
    session.projectId === projectId
    && session.parentSessionId !== undefined
    && existingSessionIds.has(session.id)
  ));
  const otherSessions = sessions.filter((session) => session.projectId !== projectId);
  const merged = new Map([...rootSessions, ...childSessions].map((session) => [session.id, session]));
  const insertAt = firstProjectIndex < 0 ? otherSessions.length : Math.min(firstProjectIndex, otherSessions.length);
  return [
    ...otherSessions.slice(0, insertAt),
    ...[...merged.values()].sort(sessionSort),
    ...otherSessions.slice(insertAt)
  ];
}

function applyUpdatesToProjectSessions(
  projectId: string,
  currentSessions: DesktopSessionSummary[],
  updates: DesktopAgentEventEnvelope[]
): DesktopSessionSummary[] {
  if (!updates.some((update) => affectsSidebarSession(update.event))) return currentSessions;
  const sessions = [...currentSessions];
  let changed = false;
  const sessionIndexes = new Map(sessions.map((session, index) => [session.id, index]));
  const upsert = (session: DesktopSessionSummary): void => {
    changed = true;
    const index = sessionIndexes.get(session.id);
    if (index === undefined) {
      sessionIndexes.set(session.id, sessions.length);
      sessions.push(session);
      return;
    }
    sessions[index] = session;
  };
  for (const update of updates) {
    const event = update.event;
    if (!event) continue;
    const visibleInput = event.type === "message.user" ? publicUserMessage(event.content) : "";
    let session = sessions[sessionIndexes.get(event.sessionId) ?? -1];
    if (!session && event.type === "message.user") {
      session = syntheticSession(projectId, event.sessionId, visibleInput);
      upsert(session);
    }
    if (session && event.type === "message.user") {
      session = {
        ...session,
        title: session.title === "新任务" ? titleFromInput(visibleInput) : session.title,
        firstUserMessage: session.firstUserMessage || visibleInput,
        status: "running",
        updatedAt: event.timestamp
      };
      upsert(session);
    }
    if (session && event.type === "run.started") {
      session = { ...session, status: "running", updatedAt: event.timestamp };
      upsert(session);
    }
    if (session && event.type === "permission.requested") {
      session = { ...session, status: "waiting_permission", updatedAt: event.timestamp };
      upsert(session);
    }
    if (session && event.type === "permission.resolved") {
      session = { ...session, status: "running", updatedAt: event.timestamp };
      upsert(session);
    }
    if (session && isTerminalRunEvent(event)) {
      upsert({
        ...session,
        status: event.type === "run.failed"
          ? "failed"
          : event.type === "run.blocked"
            ? "blocked"
            : event.type === "run.incomplete"
              ? "incomplete"
              : event.type === "run.cancelled"
                ? "cancelled"
                : event.type === "run.aborted" ? "aborted" : "completed",
        resumable: event.type === "run.incomplete" || event.type === "run.blocked"
          ? event.resumable
          : undefined,
        updatedAt: event.timestamp
      });
    }
  }
  return changed ? sessions.sort(sessionSort) : currentSessions;
}

export function lastReportedInputTokens(document?: DesktopSessionDocument): number | undefined {
  if (!document) return undefined;
  let latest: number | undefined;
  for (const event of document.events) {
    if (event.type !== "assistant_message" || event.auditOnly) continue;
    const inputTokens = event.usage?.latestRequestInputTokens ?? event.usage?.inputTokens;
    if (inputTokens !== undefined) latest = inputTokens;
  }
  return latest;
}

export function hasContextStatus(event: AgentHostEvent): event is AgentHostEvent & { context: ContextStatus } {
  return event.type === "context.updated" || event.type === "compact.completed";
}

export function updateRuntimeInfo(
  workspace: DesktopWorkspaceSnapshot | undefined,
  info: ModelRuntimeInfo
): DesktopWorkspaceSnapshot | undefined {
  if (!workspace) return workspace;
  const nextWorkspace = {
    ...workspace,
    // Runtime 尚未启动时没有 runtime.info；把已确认的模型移到首位，避免
    // 清理 optimistic 状态后 Composer 又退回旧的 defaultModel 投影。
    models: moveModelToFront(workspace.models, info.modelAlias),
    pickerModels: moveModelToFront(workspace.pickerModels, info.modelAlias)
  };
  if (!workspace.runtime) return nextWorkspace;
  return {
    ...nextWorkspace,
    runtime: {
      ...workspace.runtime,
      info: {
        ...workspace.runtime.info,
        modelAlias: info.modelAlias,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel,
        thinking: info.thinking,
        contextWindow: info.contextWindow,
        contextWindowIsFallback: info.contextWindowIsFallback,
        maxInputTokens: info.maxInputTokens,
        // 切模型后保留有效窗口/预留元数据，否则用量展示退回原始窗口，把输出预留摊进额度。
        effectiveContextWindow: info.effectiveContextWindow,
        effectiveContextWindowPercent: info.effectiveContextWindowPercent,
        contextReserveTokens: info.contextReserveTokens,
        autoCompactTokenLimit: info.autoCompactTokenLimit
      }
    }
  };
}

function moveModelToFront<T extends { alias: string }>(models: T[], alias: string): T[] {
  const index = models.findIndex((model) => model.alias === alias);
  if (index <= 0) return models;
  const selected = models[index];
  if (!selected) return models;
  return [selected, ...models.slice(0, index), ...models.slice(index + 1)];
}

export function syntheticSession(projectId: string, sessionId: string, input: string): DesktopSessionSummary {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    projectId,
    fileName: `${sessionId}.jsonl`,
    title: titleFromInput(input),
    firstUserMessage: input,
    lastAssistantMessage: "",
    eventCount: 0,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    isIncognito: false,
    status: "running",
    resumable: undefined
  };
}

export function mergeProject(projects: DesktopProject[], next: DesktopProject): DesktopProject[] {
  const index = projects.findIndex((project) => project.id === next.id);
  if (index < 0) return [next, ...projects];
  const copy = [...projects];
  copy[index] = next;
  return copy;
}

export function applyProjectOrder(projects: DesktopProject[], projectIds: string[]): DesktopProject[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const ordered: DesktopProject[] = [];
  for (const projectId of projectIds) {
    const project = byId.get(projectId);
    if (!project || seen.has(projectId)) continue;
    ordered.push(project);
    seen.add(projectId);
  }
  for (const project of projects) {
    if (!seen.has(project.id)) ordered.push(project);
  }
  return ordered;
}

export function eventsBeforeUserMessage(events: SessionEvent[], userMessageIndex: number): SessionEvent[] {
  let seen = 0;
  for (const [index, event] of events.entries()) {
    if (event.type !== "user_message" || event.auditOnly) continue;
    if (seen === userMessageIndex) return events.slice(0, index);
    seen += 1;
  }
  return events;
}

/** 保留目标用户消息本身，立即投影「从这条消息开始重写」的时间线前缀。 */
export function eventsThroughUserMessage(events: SessionEvent[], userMessageIndex: number): SessionEvent[] {
  let seen = 0;
  for (const [index, event] of events.entries()) {
    if (event.type !== "user_message" || event.auditOnly) continue;
    if (seen === userMessageIndex) return events.slice(0, index + 1);
    seen += 1;
  }
  return events;
}

function sessionSort(left: DesktopSessionSummary, right: DesktopSessionSummary): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function titleFromInput(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 64) || "新任务";
}
