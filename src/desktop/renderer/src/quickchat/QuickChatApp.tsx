/**
 * QuickChat 主页面路由。
 *
 * 这是一个轻量的聊天壳，但仍然复用 Desktop 的模型选择、Markdown 和 agent 事件协议。
 * 屏幕上下文只作为本轮 promptContext 传给 Runtime，用户气泡始终显示用户原文。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { AgentHostEvent } from "../../../../runtime/agentEvents.js";
import { isTerminalRunEvent } from "../../../../runtime/agentEvents.js";
import { modelThinkingSelections, type ThinkingSelection } from "../../../../llm/modelThinking.js";
import type {
  DesktopBootstrap,
  DesktopQuickChatScreenContext,
  DesktopQuickChatSettings
} from "../../../protocol.js";
import { AppearanceProvider } from "../AppearanceProvider.js";
import { useDesktopAppearance } from "../useDesktopAppearance.js";
import { WindowChrome } from "../components/WindowChrome.js";
import { Icon } from "../components/Icon.js";
import { MarkdownContent } from "../components/MarkdownContent.js";
import { ModelPickerMenu } from "../components/composer/ModelPickerMenu.js";
import { UserInputCard } from "../components/chat/UserInputCard.js";
import type { TimelineTool } from "../sessionTimeline.js";
import "./quickchat.css";

const MAX_INPUT_LENGTH = 4_000;

interface QuickChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  reasoningStreaming: boolean;
  activity?: string;
  streaming: boolean;
  withScreenContext?: boolean;
  questions?: TimelineTool[];
  questionSessionId?: string;
}

interface QuickChatState {
  messages: QuickChatMessage[];
}

type QuickChatAction =
  | { type: "reset" }
  | { type: "append-user"; message: QuickChatMessage }
  | { type: "ensure-assistant"; runId: string }
  | { type: "assistant-delta"; runId: string; content: string }
  | { type: "assistant-completed"; runId: string; content: string }
  | { type: "reasoning-started"; runId: string }
  | { type: "reasoning-delta"; runId: string; content: string }
  | { type: "reasoning-completed"; runId: string }
  | { type: "tool-started"; runId: string; tool: string }
  | { type: "question-event"; runId: string; event: Extract<AgentHostEvent, { type: "tool.started" | "tool.completed" | "tool.failed" }> }
  | { type: "finish-run"; runId: string; fallback?: string };

function emptyAssistant(runId: string): QuickChatMessage {
  return {
    id: runId,
    role: "assistant",
    content: "",
    reasoning: "",
    reasoningStreaming: false,
    streaming: true
  };
}

function reduceQuickChat(state: QuickChatState, action: QuickChatAction): QuickChatState {
  if (action.type === "reset") return { messages: [] };
  if (action.type === "append-user") return { messages: [...state.messages, action.message] };

  const existingIndex = state.messages.findIndex((message) => message.id === action.runId);
  const withAssistant = existingIndex === -1
    ? [...state.messages, emptyAssistant(action.runId)]
    : state.messages.slice();
  const index = existingIndex === -1 ? withAssistant.length - 1 : existingIndex;
  const existing = withAssistant[index];
  if (!existing) return state;

  switch (action.type) {
    case "ensure-assistant":
      return { messages: withAssistant };
    case "assistant-delta":
      withAssistant[index] = { ...existing, content: existing.content + action.content, streaming: true };
      return { messages: withAssistant };
    case "assistant-completed":
      withAssistant[index] = { ...existing, content: action.content, streaming: false };
      return { messages: withAssistant };
    case "reasoning-started":
      withAssistant[index] = { ...existing, reasoningStreaming: true, streaming: true };
      return { messages: withAssistant };
    case "reasoning-delta":
      withAssistant[index] = {
        ...existing,
        reasoning: existing.reasoning + action.content,
        reasoningStreaming: true,
        streaming: true
      };
      return { messages: withAssistant };
    case "reasoning-completed":
      withAssistant[index] = { ...existing, reasoningStreaming: false };
      return { messages: withAssistant };
    case "tool-started":
      withAssistant[index] = { ...existing, activity: "正在调用 " + action.tool, streaming: true };
      return { messages: withAssistant };
    case "question-event": {
      const event = action.event;
      const questions = [...existing.questions ?? []];
      const previous = questions.findIndex((tool) => tool.id === event.toolCallId);
      const tool: TimelineTool = previous >= 0 ? { ...questions[previous]! } : { id: event.toolCallId, runId: event.runId, tool: "AskUserQuestion", status: "running", args: {}, updates: [] };
      if (event.type === "tool.started") tool.args = event.args;
      else {
        tool.result = event.result;
        tool.status = event.type === "tool.failed" ? "failed" : "success";
        if (event.type === "tool.failed") tool.error = event.error;
      }
      if (previous >= 0) questions[previous] = tool; else questions.push(tool);
      withAssistant[index] = { ...existing, questions, questionSessionId: event.sessionId, activity: undefined };
      return { messages: withAssistant };
    }
    case "finish-run":
      withAssistant[index] = {
        ...existing,
        content: existing.content || action.fallback || "",
        activity: undefined,
        reasoningStreaming: false,
        streaming: false
      };
      return { messages: withAssistant };
  }
}

interface QuickChatSubmission {
  messageId: string;
  projectId: string;
  targetSessionId?: string;
  sessionId?: string;
  runId?: string;
  directReceiptRunId?: string;
  phase: "preparing" | "dispatched" | "accepted" | "unknown" | "failed" | "handed-off";
  receiptPending: boolean;
  earlyTerminals: AgentHostEvent[];
  earlyTerminalsOverflow: boolean;
  terminal: boolean;
  lifetime: { active: boolean };
}

export function QuickChatApp(): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceQuickChat, { messages: [] });
  const [input, setInput] = useState("");
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap>();
  const [settings, setSettings] = useState<DesktopQuickChatSettings>();
  const [context, setContext] = useState<DesktopQuickChatScreenContext>({});
  const [clickThrough, setClickThrough] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [modelAlias, setModelAlias] = useState<string | undefined>(undefined);
  const [thinking, setThinking] = useState<ThinkingSelection>("off");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [awaitingRun, setAwaitingRun] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const appearance = useDesktopAppearance(setError);
  const bootstrapAppearance = appearance.bootstrap;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const projectIdRef = useRef<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const pendingSendRef = useRef<QuickChatSubmission | undefined>(undefined);
  const lifetimeRef = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
    lifetimeRef.current = lifetime;
    return () => { lifetime.active = false; };
  }, []);
  const runtimeModelAliasRef = useRef<string | undefined>(undefined);
  const runtimeThinkingRef = useRef<ThinkingSelection>("off");
  const settingsRef = useRef<DesktopQuickChatSettings | undefined>(undefined);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!bootstrap) return;
    bootstrapAppearance(bootstrap);
  }, [bootstrapAppearance, bootstrap]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextSettings, nextBootstrap, cachedContext, nextClickThrough] = await Promise.all([
          window.biny.quickChatSettings(),
          window.biny.bootstrap(),
          window.biny.quickChatScreenContext(),
          window.biny.getQuickChatClickThrough()
        ]);
        if (cancelled) return;
        setSettings(nextSettings);
        settingsRef.current = nextSettings;
        setBootstrap(nextBootstrap);
        setContext(cachedContext);
        setClickThrough(nextClickThrough);
        const projectId = nextBootstrap.activeProjectId ?? nextBootstrap.projects.at(0)?.id;
        projectIdRef.current = projectId;
        setProjectId(projectId);
        const runtimeInfo = nextBootstrap.workspace?.runtime?.info;
        const initialModel = runtimeInfo?.modelAlias
          ? nextBootstrap.workspace?.pickerModels.find((model) => model.alias === runtimeInfo.modelAlias)
          : nextBootstrap.workspace?.pickerModels.at(0);
        const initialAlias = runtimeInfo?.modelAlias ?? initialModel?.alias;
        const initialThinking = runtimeInfo?.thinking ?? initialModel?.defaultThinking ?? "off";
        setModelAlias(initialAlias);
        setThinking(initialThinking);
        runtimeModelAliasRef.current = initialAlias;
        runtimeThinkingRef.current = initialThinking;
      } catch (nextError) {
        if (!cancelled) setError(errorText(nextError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.biny.onQuickChatContext(setContext), []);

  useEffect(() => {
    const unsubscribe = window.biny.onQuickChatFocusInput(() => inputRef.current?.focus());
    inputRef.current?.focus();
    return unsubscribe;
  }, []);

  useEffect(() => window.biny.onQuickChatClickThroughChanged(setClickThrough), []);

  useEffect(() => {
    const unsubscribe = window.biny.onAgentEvent((envelope) => {
      const event = envelope.event;
      const projectId = projectIdRef.current;
      if (!event || !projectId || envelope.projectId !== projectId) return;

      const owner = pendingSendRef.current;
      if (!owner || !owner.lifetime.active || owner.projectId !== projectId || owner.terminal || owner.phase === "handed-off") return;
      // Admission can fail before run.started. Retain bounded terminal evidence until
      // a direct receipt proves which run belongs to this exact message.
      if (owner.phase === "dispatched" && owner.runId === undefined && isTerminalRunEvent(event)) {
        if (owner.earlyTerminals.length < 32) owner.earlyTerminals.push(event);
        else owner.earlyTerminalsOverflow = true;
        return;
      }
      if (owner.runId === undefined && isTerminalRunEvent(event)
        && event.runId === owner.directReceiptRunId && event.sessionId === owner.sessionId) {
        owner.runId = event.runId;
        setAwaitingRun(false);
      }
      if (event.type === "run.started") {
        if (event.messageId !== owner.messageId || owner.phase === "preparing" || owner.phase === "failed"
          || (owner.targetSessionId !== undefined && event.sessionId !== owner.targetSessionId)
          || (owner.sessionId !== undefined && event.sessionId !== owner.sessionId)
          || (owner.runId !== undefined && event.runId !== owner.runId)) return;
        owner.sessionId = event.sessionId;
        owner.runId = event.runId;
        owner.phase = "accepted";
        sessionIdRef.current = event.sessionId;
        setAwaitingRun(false);
        setBusy(true);
      } else if (event.sessionId !== owner.sessionId || event.runId !== owner.runId) return;
      if (isTerminalRunEvent(event)) owner.terminal = true;
      handleQuickChatEvent(event, dispatch, (running) => setBusy(owner.receiptPending || running), activeRunIdRef, setActiveRunId);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = String(Math.min(node.scrollHeight, 132)) + "px";
  }, [input]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.messages]);

  const models = useMemo(() => bootstrap?.workspace?.pickerModels ?? [], [bootstrap]);
  const selectedModel = useMemo(
    () => models.find((model) => model.alias === modelAlias) ?? models.at(0),
    [modelAlias, models]
  );
  const selectedAlias = selectedModel?.alias;
  const thinkingLevels = useMemo(
    () => selectedModel ? modelThinkingSelections(selectedModel) : [],
    [selectedModel]
  );
  const currentThinking = selectedModel?.efforts.length ? thinking : "off";
  const hasModel = selectedAlias !== undefined && models.length > 0;
  const noProject = projectId === undefined;
  const includeContext = settings?.injectScreenContext ?? true;
  const contextAttached = includeContext && Boolean(context.promptContext);
  const windowTitle = context.frontApp?.url
    ? safeUrlHost(context.frontApp.url) ?? context.frontApp.windowTitle
    : context.frontApp?.windowTitle;

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    const currentProjectId = projectIdRef.current;
    const previous = pendingSendRef.current;
    if (!text || busy || !currentProjectId || !hasModel || !lifetimeRef.current.active
      || previous?.receiptPending || (previous?.runId !== undefined && !previous.terminal)) return;
    if (previous?.phase === "unknown" || previous?.phase === "handed-off") {
      setError("上一条消息需要在主窗口核对或查看。请勿盲目重发；如需新建快速对话，旧请求或队列消息不会被撤销。");
      return;
    }
    const owner: QuickChatSubmission = {
      messageId: globalThis.crypto.randomUUID(), projectId: currentProjectId,
      targetSessionId: sessionIdRef.current, phase: "preparing", receiptPending: true, terminal: false,
      lifetime: lifetimeRef.current, earlyTerminals: [], earlyTerminalsOverflow: false
    };
    pendingSendRef.current = owner;
    const current = (): boolean => owner.lifetime.active && pendingSendRef.current === owner;
    setBusy(true);
    setAwaitingRun(false);
    setError(undefined);
    try {
      // Transfer only this submission before awaiting model preparation; newer typing stays in the editor.
      dispatch({ type: "append-user", message: {
        id: owner.messageId, role: "user", content: text, reasoning: "", reasoningStreaming: false,
        streaming: false, withScreenContext: contextAttached
      } });
      setInput("");
      const nextThinking = selectedModel?.efforts.length ? thinking : "off";
      if (runtimeModelAliasRef.current !== selectedAlias || runtimeThinkingRef.current !== nextThinking) {
        const info = await window.biny.switchModel(currentProjectId, selectedAlias!, nextThinking);
        if (!current()) return;
        runtimeModelAliasRef.current = info.modelAlias;
        runtimeThinkingRef.current = info.thinking;
      }
      if (!current()) return;
      owner.phase = "dispatched";
      const receipt = await window.biny.sendPrompt(
        owner.projectId, owner.targetSessionId, text, [], undefined, undefined, owner.messageId,
        contextAttached ? context.promptContext : undefined
      );
      if (!current()) return;
      if (receipt.messageId !== owner.messageId
        || (owner.targetSessionId !== undefined && receipt.sessionId !== owner.targetSessionId)
        || (owner.sessionId !== undefined && receipt.sessionId !== owner.sessionId)) throw new Error("发送回执与当前消息身份不一致。");
      owner.phase = "accepted";
      owner.receiptPending = false;
      owner.sessionId = receipt.sessionId;
      owner.directReceiptRunId = receipt.queued === false ? receipt.runId : undefined;
      // A queued-message receipt names the preceding run, not this message's future run.
      // Only the matching run.started event may grant run/control ownership.
      sessionIdRef.current = receipt.sessionId;
      const earlyTerminal = receipt.queued === false ? owner.earlyTerminals.find(
        (event) => event.sessionId === receipt.sessionId && event.runId === receipt.runId
      ) : undefined;
      owner.earlyTerminals = [];
      if (earlyTerminal && owner.runId === undefined) {
        owner.runId = receipt.runId;
        owner.terminal = true;
        handleQuickChatEvent(earlyTerminal, dispatch, setBusy, activeRunIdRef, setActiveRunId);
      }
      setAwaitingRun(owner.runId === undefined && !owner.terminal);
      if (owner.runId === undefined && (receipt.queued !== false || owner.earlyTerminalsOverflow)) {
        owner.phase = "handed-off";
        setAwaitingRun(false);
        setBusy(false);
        setError(receipt.queued === true
          ? "已交会话队列，请在主窗口查看。队列可能合并消息，快速窗口不认领其运行。新建对话不会撤销已入队消息，请勿重复发送。"
          : "消息已接纳，但快速窗口无法完整确认运行状态，请在主窗口查看。快速窗口不会猜测运行归属；新建对话不会撤销旧消息，请勿重复发送。");
      } else if (owner.terminal) {
        activeRunIdRef.current = undefined;
        setActiveRunId(undefined);
        setBusy(false);
      }
    } catch (sendError) {
      if (!current()) return;
      owner.receiptPending = false;
      // A matching run event is admission evidence even when the later IPC acknowledgment fails.
      if (owner.phase === "accepted") {
        setAwaitingRun(owner.runId === undefined && !owner.terminal);
        setBusy(!owner.terminal);
        setError(`已观察到该消息的运行，回执处理失败；不会重发：${errorText(sendError)}`);
      } else {
        const notSent = owner.phase === "preparing";
        owner.phase = notSent ? "failed" : "unknown";
        setAwaitingRun(false);
        activeRunIdRef.current = undefined;
        setActiveRunId(undefined);
        setBusy(false);
        setError(`${notSent ? "发送前失败，未派发消息" : "发送结果尚未确认，请先在主窗口核对会话，避免重复发送"}。原文保留在上方消息中：${errorText(sendError)}`);
      }
    }
  }, [busy, context.promptContext, contextAttached, hasModel, input, selectedAlias, selectedModel, thinking]);

  const chooseModel = useCallback((alias: string): void => {
    const next = models.find((model) => model.alias === alias);
    if (!next) return;
    setModelAlias(alias);
    setThinking(next.efforts.length ? next.defaultThinking : "off");
    setModelMenuOpen(false);
  }, [models]);

  const chooseThinking = useCallback((next: ThinkingSelection): void => {
    setThinking(next);
    setModelMenuOpen(false);
  }, []);

  const updateIncludeContext = useCallback(async (enabled: boolean): Promise<void> => {
    const current = settingsRef.current;
    if (!current) return;
    const next = { ...current, injectScreenContext: enabled };
    setSettings(next);
    settingsRef.current = next;
    try {
      await window.biny.setQuickChatSettings(next);
    } catch (settingsError) {
      setSettings(current);
      settingsRef.current = current;
      setError(errorText(settingsError));
    }
  }, []);

  const loadTraversal = useCallback(async (): Promise<void> => {
    const pid = context.frontApp?.pid;
    if (!pid) return;
    try {
      setContext(await window.biny.traverseQuickChatApp(pid));
    } catch (traversalError) {
      setError(errorText(traversalError));
    }
  }, [context.frontApp?.pid]);

  const setRuntimeClickThrough = useCallback(async (): Promise<void> => {
    try {
      setClickThrough(await window.biny.setQuickChatClickThrough(!clickThrough));
    } catch (clickThroughError) {
      setError(errorText(clickThroughError));
    }
  }, [clickThrough]);

  const stop = useCallback(async (): Promise<void> => {
    const currentProjectId = projectIdRef.current;
    const owner = pendingSendRef.current;
    const runId = activeRunIdRef.current;
    if (!currentProjectId || !runId || !owner?.lifetime.active || owner.projectId !== currentProjectId
      || owner.runId !== runId || owner.terminal || owner.phase !== "accepted") return;
    try {
      await window.biny.cancelRun(currentProjectId, runId);
    } catch (stopError) {
      if (owner.lifetime.active && pendingSendRef.current === owner) setError(errorText(stopError));
    }
  }, []);

  const startNewChat = useCallback((): void => {
    const owner = pendingSendRef.current;
    if ((busy && !awaitingRun) || owner?.receiptPending || (owner?.runId !== undefined && !owner.terminal)) return;
    sessionIdRef.current = undefined;
    activeRunIdRef.current = undefined;
    setActiveRunId(undefined);
    pendingSendRef.current = undefined;
    dispatch({ type: "reset" });
    setBusy(false);
    setAwaitingRun(false);
    setError(owner?.phase === "unknown" || owner?.phase === "handed-off" || (owner?.phase === "accepted" && !owner.terminal)
      ? "新对话已开始；先前消息可能仍在运行或排队，未被取消。请勿盲目重发。" : undefined);
  }, [awaitingRun, busy]);

  return (
    <AppearanceProvider snapshot={appearance.snapshot} onError={setError}><div className="quickchat-root">
      <WindowChrome title="Biny · 快速对话" />
      <header className="quickchat-titlebar">
        <div className="quickchat-title" aria-label="Quick Chat">
          <span className="quickchat-title-mark"><Icon name="spark" size={14} /></span>
          <span>快速对话{clickThrough ? " · ambient（按快捷键唤醒）" : ""}</span>
        </div>
        <div className="quickchat-title-actions">
          <div className="quickchat-model-anchor" ref={modelAnchorRef}>
            <button
              aria-expanded={modelMenuOpen}
              aria-haspopup="menu"
              className="quickchat-model-button"
              title={selectedModel?.displayName}
              disabled={!hasModel || busy}
              onClick={() => setModelMenuOpen((open) => !open)}
              type="button"
            >
              <span>{selectedModel?.displayName ?? "无可用模型"}</span>
              {selectedModel?.efforts.length ? <small>{currentThinking}</small> : null}
              <Icon name="chevron" size={11} />
            </button>
            <ModelPickerMenu
              anchorRef={modelAnchorRef}
              currentAlias={selectedAlias}
              currentModelName={selectedModel?.displayName ?? "无可用模型"}
              currentThinking={currentThinking}
              models={models}
              onClose={() => setModelMenuOpen(false)}
              onSelectModel={chooseModel}
              onSelectThinking={chooseThinking}
              open={modelMenuOpen}
              thinkingLevels={thinkingLevels}
            />
          </div>
          <button
            aria-label={clickThrough ? "关闭点击穿透" : "开启点击穿透"}
            className="quickchat-icon-button"
            onClick={() => void setRuntimeClickThrough()}
            title={clickThrough ? "关闭点击穿透" : "开启点击穿透"}
            type="button"
          >
            <Icon name={clickThrough ? "eye-off" : "eye"} size={15} />
          </button>
          <button aria-label="新建快速对话" className="quickchat-icon-button" disabled={busy && !awaitingRun} onClick={startNewChat} title="新建对话" type="button">
            <Icon name="add" size={16} />
          </button>
          <button aria-label="关闭快速对话" className="quickchat-icon-button" onClick={() => void window.biny.closeQuickChat()} title="关闭窗口" type="button">
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      {context.frontApp ? (
        <section className="quickchat-context-chip" aria-label="当前前台应用上下文">
          {context.appIconDataUrl ? <img alt="" className="quickchat-context-icon" src={context.appIconDataUrl} /> : <span className="quickchat-context-icon quickchat-context-icon-placeholder"><Icon name="display" size={15} /></span>}
          <div className="quickchat-context-copy">
            <strong>{context.frontApp.appName || "前台应用"}</strong>
            <span>{windowTitle || "当前窗口"}</span>
          </div>
          <div className="quickchat-context-actions">
            {context.traversal?.source === "ax" ? <span className="quickchat-context-status" title="已读取窗口文本">·✓</span> : null}
            {!context.traversal?.content && !context.frontApp.permissionDenied ? (
              <button className="quickchat-context-read" onClick={() => void loadTraversal()} type="button">读取内容</button>
            ) : null}
            {context.frontApp.permissionDenied ? (
              <button className="quickchat-context-read" onClick={() => void window.biny.openSystemSettings("accessibility")} type="button">授权辅助功能</button>
            ) : null}
            <button
              aria-label={includeContext ? "不附带前台上下文" : "附带前台上下文"}
              className="quickchat-context-toggle"
              onClick={() => void updateIncludeContext(!includeContext)}
              title={includeContext ? "本轮会附带前台应用上下文" : "本轮不附带前台应用上下文"}
              type="button"
            >
              <Icon name={includeContext ? "eye" : "eye-off"} size={14} />
            </button>
          </div>
        </section>
      ) : null}

      <main className="quickchat-messages" ref={scrollRef}>
        {state.messages.length === 0 ? (
          <div className="quickchat-empty">
            <strong>{noProject ? "先在主窗口打开一个项目" : !hasModel ? "先配置一个可用模型" : "问点什么…"}</strong>
            <span>{context.frontApp ? "已识别 " + context.frontApp.appName + "，可选择是否附带当前窗口上下文。" : "按 Command+Shift+Space 可再次唤起并刷新上下文。"}</span>
          </div>
        ) : (
          state.messages.map((message) => (
            <article className={["quickchat-message", "quickchat-message-" + message.role].join(" ")} key={message.id}>
              {message.role === "user" ? (
                <>
                  {message.withScreenContext ? <span className="quickchat-message-context">已附带前台上下文</span> : null}
                  <div className="quickchat-user-text">{message.content}</div>
                </>
              ) : (
                <>
                  {message.reasoning ? (
                    <details className="quickchat-reasoning" open={message.reasoningStreaming}>
                      <summary>{message.reasoningStreaming ? "正在思考" : "思考过程"}</summary>
                      <div>{message.reasoning}</div>
                    </details>
                  ) : null}
                  {message.activity ? <div className="quickchat-activity">{message.activity}</div> : null}
                  {message.questions?.map((tool) => <UserInputCard key={tool.id} tool={tool} projectId={projectId ?? ""} sessionId={message.questionSessionId} running={message.id === activeRunId} />)}
                  {message.content ? (
                    <MarkdownContent
                      content={message.content}
                      onOpenExternal={(url) => { void window.biny.openExternal(url); }}
                      onPreviewFile={(path) => { if (projectId) void window.biny.openWorkspaceFile(projectId, path); }}
                      projectId={projectId ?? ""}
                    />
                  ) : message.streaming ? (
                    <span className="quickchat-typing" aria-label="正在生成"><i /><i /><i /></span>
                  ) : null}
                </>
              )}
            </article>
          ))
        )}
      </main>

      {error ? <div className="quickchat-error" role="alert">{error}</div> : null}
      {noProject ? <div className="quickchat-banner">还没有可用项目，请先在主窗口打开一个项目。</div> : null}
      {!noProject && !hasModel ? <div className="quickchat-banner">当前项目没有可用模型，请先在主窗口配置连接。</div> : null}

      <footer className="quickchat-composer">
        <textarea
          aria-label="快速对话输入"
          autoFocus
          className="quickchat-input"
          disabled={noProject || !hasModel}
          maxLength={MAX_INPUT_LENGTH}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              void window.biny.closeQuickChat();
              return;
            }
            if (event.key === " " && (event.metaKey || event.ctrlKey) && event.shiftKey) {
              event.preventDefault();
              void window.biny.closeQuickChat();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={context.frontApp ? "和 " + context.frontApp.appName + " 对话…" : "发消息…（Enter 发送，Shift+Enter 换行）"}
          ref={inputRef}
          rows={1}
          value={input}
        />
        <div className="quickchat-composer-footer">
          <span className="quickchat-composer-hint">{includeContext ? "当前窗口上下文已开启" : "仅发送输入内容"}</span>
          <button
            aria-label={busy ? activeRunId === undefined ? awaitingRun ? "等待消息运行" : "等待发送确认" : "停止生成" : "发送"}
            className="quickchat-send"
            disabled={busy ? activeRunId === undefined : !input.trim() || noProject || !hasModel}
            onClick={() => void (busy ? stop() : send())}
            type="button"
          >
            <Icon name={busy ? "stop" : "arrow-up"} size={15} />
          </button>
        </div>
      </footer>
    </div></AppearanceProvider>
  );
}

function handleQuickChatEvent(
  event: AgentHostEvent,
  dispatch: Dispatch<QuickChatAction>,
  setBusy: (busy: boolean) => void,
  activeRunIdRef: { current: string | undefined },
  setActiveRunId: (runId: string | undefined) => void
): void {
  if (event.type === "run.started") {
    activeRunIdRef.current = event.runId;
    setActiveRunId(event.runId);
    dispatch({ type: "ensure-assistant", runId: event.runId });
    return;
  }
  if (event.type === "assistant.delta") {
    dispatch({ type: "assistant-delta", runId: event.runId, content: event.content });
    return;
  }
  if (event.type === "assistant.completed") {
    dispatch({ type: "assistant-completed", runId: event.runId, content: event.content });
    return;
  }
  if (event.type === "reasoning.started") {
    dispatch({ type: "reasoning-started", runId: event.runId });
    return;
  }
  if (event.type === "reasoning.delta") {
    dispatch({ type: "reasoning-delta", runId: event.runId, content: event.content });
    return;
  }
  if (event.type === "reasoning.completed") {
    dispatch({ type: "reasoning-completed", runId: event.runId });
    return;
  }
  if ((event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") && event.tool === "AskUserQuestion") {
    dispatch({ type: "question-event", runId: event.runId, event });
    return;
  }
  if (event.type === "tool.started") {
    dispatch({ type: "tool-started", runId: event.runId, tool: event.tool });
    return;
  }
  if (!isTerminalRunEvent(event)) return;
  const fallback = event.type === "run.failed"
    ? event.error
    : event.type === "run.blocked"
      ? event.summary
      : event.type === "run.incomplete" || event.type === "run.cancelled" || event.type === "run.aborted"
        ? event.reason
        : undefined;
  dispatch({ type: "finish-run", runId: event.runId, fallback });
  setBusy(false);
  activeRunIdRef.current = undefined;
  setActiveRunId(undefined);
}

function safeUrlHost(value: string): string | undefined {
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
