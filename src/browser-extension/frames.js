/** 按标签与 CDP 子会话保存框架上下文；导航销毁上下文后旧 documentId 立即失效。 */
export async function trackFrameEvent(api, state, source, method, params) {
  const tabId = source.tabId;
  if (!state.attached.has(tabId)) return;
  const assertCurrent = () => { if (!state.attached.has(tabId) || (state.connected && !state.connected())) throw new Error("框架连接已中断。"); };
  const contexts = state.contexts.get(tabId) ?? new Map();
  state.contexts.set(tabId, contexts);
  if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
    const target = { tabId, sessionId: params.sessionId };
    await api.debugger.sendCommand(target, "Page.enable", {});
    assertCurrent();
    await api.debugger.sendCommand(target, "Runtime.enable", {});
    assertCurrent();
    await api.debugger.sendCommand(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] });
  } else if (method === "Runtime.executionContextCreated") {
    const context = params.context;
    if (context.auxData?.isDefault && context.auxData.frameId && (contexts.size < 200 || contexts.has(context.auxData.frameId))) contexts.set(context.auxData.frameId, {
      frameId: context.auxData.frameId, contextId: context.id, documentId: context.uniqueId || `${source.sessionId || "main"}:${context.id}`,
      sessionId: source.sessionId, url: context.origin
    });
  } else if (method === "Runtime.executionContextDestroyed" || method === "Runtime.executionContextsCleared" || method === "Target.detachedFromTarget") {
    for (const [id, context] of contexts) {
      const sessionId = method === "Target.detachedFromTarget" ? params.sessionId : source.sessionId;
      if (context.sessionId === sessionId && (method !== "Runtime.executionContextDestroyed" || context.contextId === params.executionContextId)) contexts.delete(id);
    }
  }
}
