/** 只接受语义操作，页面代码由本模块固定构造，外部调用方不能发送任意 CDP 或 JavaScript。 */
import { pageOperation } from "./page.js";

export async function performBrowserCommand(api, { method, args = {} }, state) {
  const deadline = Date.now() + (args.timeoutMs ?? 8000);
  let mainFrameId;
  let pinnedDocument;
  const assertConnected = () => { if (!state.connected()) throw new Error("浏览器连接已中断；结果可能未确认。"); };
  assertConnected();
  const http = (url) => { try { const value = new URL(url); return ["http:", "https:"].includes(value.protocol) && !value.username && !value.password; } catch { return false; } };
  if (method === "tabs") return (await api.tabs.query({})).filter((tab) => http(tab.url)).slice(0, 1000).map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url, title: (tab.title || "").slice(0, 4096), active: tab.active }));
  if (!["read", "navigate", "click", "fill", "press", "screenshot", "scroll", "wait", "upload", "download"].includes(method) || !Number.isInteger(args.tabId) || args.tabId < 0) throw new Error("不支持的浏览器操作或标签 ID。");
  const tab = await api.tabs.get(args.tabId);
  if (!http(tab.url)) throw new Error("仅支持普通 HTTP(S) 网页，不能操作浏览器内部页面。");
  if (state.dialogs.has(tab.id)) throw new Error("网页有待处理的确认框，请用户在 Chrome 中处理后继续。");
  const send = async (name, params = {}, sessionId) => {
    assertConnected();
    // 每个原生动作重新核对标签类型，避免页面跳到浏览器设置后继续输入。
    if (!http((await api.tabs.get(tab.id)).url)) throw new Error("标签已离开普通网页，请重新列出标签。");
    assertConnected();
    if (!state.attached.has(tab.id)) {
      await api.debugger.attach({ tabId: tab.id }, "1.3");
      try {
        // attach 的迟到完成不属于新连接；先核对再启用事件或派发页面操作。
        assertConnected();
        state.attached.add(tab.id);
        await api.debugger.sendCommand({ tabId: tab.id }, "Page.enable", {});
        assertConnected();
        await api.debugger.sendCommand({ tabId: tab.id }, "Runtime.enable", {});
        assertConnected();
        await api.debugger.sendCommand({ tabId: tab.id }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] });
        assertConnected();
      } catch (error) {
        try { await api.debugger.detach({ tabId: tab.id }); }
        catch { throw new Error("调试连接释放未确认，请在 Chrome 中取消调试或重新加载扩展。"); }
        finally { state.attached.delete(tab.id); state.dialogs.delete(tab.id); }
        throw error;
      }
    }
    assertConnected();
    if (state.dialogs.has(tab.id)) throw new Error("网页有待处理的确认框，请用户手动处理。");
    return api.debugger.sendCommand(sessionId ? { tabId: tab.id, sessionId } : { tabId: tab.id }, name, params);
  };
  const context = () => {
    const selected = state.contexts?.get(tab.id)?.get(args.frameId || mainFrameId);
    if (!selected && !args.frameId && !args.documentId && !pinnedDocument) return undefined;
    if (!selected || (args.documentId && selected.documentId !== args.documentId) || (pinnedDocument && selected.documentId !== pinnedDocument)) throw new Error("框架或文档已变化，请重新读取页面。");
    if (!http(selected.url)) throw new Error("框架不是普通 HTTP(S) 页面。");
    return selected;
  };
  const evaluate = async (operation, input = args) => {
    const tree = await send("Page.getFrameTree"); mainFrameId = tree.frameTree?.frame?.id;
    const selected = context();
    pinnedDocument = selected?.documentId;
    if (operation === "wait") input = { ...input, timeoutMs: Math.max(0, Math.min(input.timeoutMs ?? 5000, deadline - Date.now())) };
    const params = { expression: `(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(input)})`, returnByValue: true, awaitPromise: true };
    if (selected) params.contextId = selected.contextId;
    let result;
    if (input.selector?.startsWith("backend=")) {
      if (!args.frameId || !args.documentId || !/^backend=\d+$/u.test(input.selector)) throw new Error("节点引用必须带当前框架和文档 ID，请重新读取。");
      const remote = await send("DOM.resolveNode", { backendNodeId: Number(input.selector.slice(8)), executionContextId: selected.contextId }, selected.sessionId);
      if (!remote.object?.objectId) throw new Error("节点已失效，请重新读取。");
      try {
        result = await send("Runtime.callFunctionOn", { objectId: remote.object.objectId, returnByValue: true, awaitPromise: true,
          functionDeclaration: `function(operation,args) { return (${pageOperation.toString()})(operation,args,this); }`, arguments: [{ value: operation }, { value: input }] }, selected.sessionId);
      } finally { await send("Runtime.releaseObject", { objectId: remote.object.objectId }, selected.sessionId); }
    } else result = await send("Runtime.evaluate", params, selected?.sessionId);
    if (result.exceptionDetails) throw new Error("页面元素不可操作或已变化：" + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || "请重新读取页面。"));
    assertConnected(); context();
    return result.result?.value;
  };
  const pointer = async (point) => {
    const selected = context();
    if (selected) {
      const tree = await send("Page.getFrameTree", {}, selected.sessionId);
      if (tree.frameTree?.frame?.id !== selected.frameId) {
        const owner = await send("DOM.getFrameOwner", { frameId: selected.frameId }, selected.sessionId);
        const { model } = await send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, selected.sessionId);
        if (!model?.content || model.content.length !== 8) throw new Error("框架坐标不可用。");
        const quad = model.content;
        // 有旋转或倾斜时不能把局部坐标当作主视口坐标，拒绝猜测点击位置。
        if (quad[1] !== quad[3] || quad[0] !== quad[6]) throw new Error("框架存在旋转变换，无法可靠定位。");
        point = { x: quad[0] + point.x * (point.viewportWidth ? (quad[2] - quad[0]) / point.viewportWidth : 1), y: quad[1] + point.y * (point.viewportHeight ? (quad[7] - quad[1]) / point.viewportHeight : 1) };
      }
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("元素坐标无效，请重新读取。");
    context(); return { point: { x: point.x, y: point.y }, sessionId: selected?.sessionId };
  };
  if (method === "read") {
    const max = args.maxCharacters ?? 24000;
    if (!Number.isInteger(max) || max < 1000 || max > 100000) throw new Error("读取长度无效。");
    const result = await evaluate("read");
    const selected = context();
    if (selected) {
      await send("DOM.enable", {}, selected.sessionId);
      const document = await send("DOM.getDocument", { depth: -1, pierce: true }, selected.sessionId);
      let root = document.root;
      const tree = await send("Page.getFrameTree", {}, selected.sessionId);
      if (tree.frameTree?.frame?.id !== selected.frameId) {
        const owner = await send("DOM.getFrameOwner", { frameId: selected.frameId }, selected.sessionId);
        root = (await send("DOM.describeNode", { backendNodeId: owner.backendNodeId, depth: -1, pierce: true }, selected.sessionId)).node?.contentDocument;
      }
      const queue = root ? [{ node: root, closed: false }] : [];
      let visited = 0;
      while (visited < queue.length && visited < 20000 && result.interactive.length < 200) {
        const { node, closed } = queue[visited++];
        if (["SCRIPT", "STYLE"].includes(node.nodeName)) continue;
        if (closed) {
          const attrs = Object.fromEntries(Array.from({ length: (node.attributes?.length || 0) / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
          if (["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(node.nodeName) || ["button", "link"].includes(attrs.role) || attrs.contenteditable === "true") result.interactive.push({ tag: node.nodeName.toLowerCase(), name: (attrs["aria-label"] || attrs.placeholder || "").slice(0, 120), selector: `backend=${node.backendNodeId}` });
          if (node.nodeName === "#text") result.text = (result.text + "\n" + node.nodeValue).slice(0, max);
        }
        for (const child of node.children || []) queue.push({ node: child, closed });
        for (const shadow of node.shadowRoots || []) queue.push({ node: shadow, closed: closed || shadow.shadowRootType === "closed" });
      }
    }
    return { ...result, frameId: selected?.frameId, documentId: selected?.documentId,
      frames: [...(state.contexts?.get(tab.id)?.values() || [])].filter((item) => http(item.url)).slice(0, 200).map(({ frameId, documentId, url }) => ({ frameId, documentId, url })) };
  }
  if (method === "screenshot") {
    const params = { format: "png", captureBeyondViewport: Boolean(args.fullPage) };
    if (args.fullPage) {
      const metrics = await send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      if (!size || size.width * size.height > 32000000 || size.height > 16000 || size.width > 8192) throw new Error("页面过大，请分段截图。");
      params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
    }
    const result = await send("Page.captureScreenshot", params);
    if (typeof result.data !== "string" || result.data.length > 12 * 1024 * 1024) throw new Error("截图超过大小限制。");
    return { mimeType: "image/png", data: result.data };
  }
  if (method === "download") return evaluate("download");
  if (method === "wait") {
    if (!args.selector && !["domcontentloaded", "load"].includes(args.state)) throw new Error("元素等待需要选择器。");
    await evaluate("wait"); return { success: true, url: (await api.tabs.get(tab.id)).url };
  }
  if (method === "navigate") {
    if (typeof args.url !== "string" || args.url.length > 4096 || !http(args.url)) throw new Error("导航地址必须为 HTTP(S)。");
    assertConnected();
    if (!args.waitUntil || args.waitUntil === "none") { await api.tabs.update(tab.id, { url: args.url }); return { success: true, url: args.url }; }
    const navigation = await send("Page.navigate", { url: args.url });
    if (navigation.errorText || navigation.isDownload) throw new Error(navigation.errorText || "导航触发下载，没有新文档可等待。");
    while (true) {
      const tree = await send("Page.getFrameTree");
      if (!navigation.loaderId || tree.frameTree?.frame?.loaderId === navigation.loaderId) break;
      if (Date.now() >= deadline) throw new Error("等待新文档提交超时，请重新读取页面确认导航结果。");
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await evaluate("wait", { state: args.waitUntil, timeoutMs: Math.max(0, deadline - Date.now()) });
    return { success: true, url: (await api.tabs.get(tab.id)).url };
  }
  if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector.trim() || args.selector.length > 2000)) throw new Error("元素选择器无效。");
  if (!["press", "scroll"].includes(method) && !args.selector) throw new Error("需要从页面读取结果中选择一个元素。");
  if (method === "fill" && (typeof args.value !== "string" || args.value.length > 50000)) throw new Error("输入内容无效。");
  const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
  if (method === "press" && !Object.hasOwn(keys, args.key)) throw new Error("不支持的按键。");
  if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 8000)) throw new Error("等待时限无效。");
  if (method === "scroll" && (!Number.isFinite(args.deltaY) || Math.abs(args.deltaY) > 10000 || (args.deltaX !== undefined && (!Number.isFinite(args.deltaX) || Math.abs(args.deltaX) > 10000)))) throw new Error("滚动距离无效。");
  if (method === "upload" && (!Array.isArray(args.files) || !args.files.length || args.files.length > 10 || args.files.some((file) => typeof file.name !== "string" || /[/\\\x00]/u.test(file.name) || typeof file.data !== "string") || args.files.reduce((size, file) => size + file.data.length, 0) > 12 * 1024 * 1024)) throw new Error("上传文件无效或过大。");
  if (args.selector) {
    await evaluate("wait", { ...args, state: "attached" });
    if (method !== "upload") {
      await evaluate("reveal");
      await evaluate("wait", { ...args, state: "visible" });
    }
    const point = await evaluate(method);
    if (method === "upload") return { success: true, url: (await api.tabs.get(tab.id)).url };

    if (method === "click") {
      const target = await pointer(point);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...target.point }, target.sessionId);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...target.point }, target.sessionId);
    }
  }
  if (method === "scroll") {
    const target = await pointer(await evaluate("scroll"));
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...target.point, deltaX: args.deltaX ?? 0, deltaY: args.deltaY }, target.sessionId);
  }
  if (method === "fill") await send("Input.insertText", { text: args.value }, context()?.sessionId);
  if (method === "press") {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: args.key, windowsVirtualKeyCode: keys[args.key], ...(args.key === "Enter" ? { text: "\r" } : {}) }, context()?.sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: args.key, windowsVirtualKeyCode: keys[args.key] }, context()?.sessionId);
  }
  const current = await api.tabs.get(tab.id);
  return { success: true, url: current.url };
}
