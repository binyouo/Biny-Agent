/** Chrome 边界：仅执行白名单操作；失去连接后不排队重放，网页确认框留给用户。 */
import { performBrowserCommand } from "./commands.js";
import { trackFrameEvent } from "./frames.js";

let socket;
let retry;
let retryDelay = 1000;
let status = "未连接";
let busy = false;
let generation = 0;
let cleanup = Promise.resolve();
const attached = new Set();
const dialogs = new Set();
const contexts = new Map();

function setStatus(text) {
  status = text;
  void chrome.action.setBadgeText({ text: text === "已连接" ? "ON" : "" });
}

async function connect() {
  clearTimeout(retry);
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  const attempt = generation;
  await cleanup;
  const { pairingUrl, browserName = "Chrome" } = await chrome.storage.local.get(["pairingUrl", "browserName"]);
  if (attempt !== generation || (socket && socket.readyState < WebSocket.CLOSING)) return;
  if (!pairingUrl) { setStatus("未配对：请在设置中粘贴 Biny 配对地址。"); return; }
  let url;
  try { url = new URL(pairingUrl); } catch { setStatus("配对地址无效"); return; }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/relay" || !/^[a-f0-9]{64}$/.test(url.searchParams.get("token") || "")) { setStatus("配对地址无效"); return; }
  const current = new WebSocket(url.href);
  socket = current;
  setStatus("连接中");
  current.onopen = () => { current.send(JSON.stringify({ type: "hello", version: 2, browserName: String(browserName).slice(0, 80) })); };
  current.onmessage = async ({ data }) => {
    if (current !== socket) return;
    let command;
    try { command = JSON.parse(data); } catch { current.close(); return; }
    if (command.type === "ready") { retryDelay = 1000; setStatus("已连接"); return; }
    if (command.type === "heartbeat") return;
    if (typeof command.id !== "string") { current.close(); return; }
    if (busy) { current.send(JSON.stringify({ id: command.id, ok: false, error: "浏览器忙，请等待上一项操作完成。" })); return; }
    busy = true;
    const mutation = !["tabs", "read", "screenshot", "wait"].includes(command.method);
    try {
      const result = await performBrowserCommand(chrome, command, { attached, dialogs, contexts, connected: () => current === socket && current.readyState === WebSocket.OPEN });
      if (current === socket && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ id: command.id, ok: true, result }));
    } catch (error) {
      // 派发后的错误不能证明没有副作用；不让后续连接接收旧响应。
      if (current === socket && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ id: command.id, ok: false, unknown: mutation, error: String(error.message || "浏览器操作失败").slice(0, 1000) }));
    } finally { busy = false; }
  };
  current.onerror = () => { setStatus("连接失败：检查 Biny 是否运行，或重新复制配对地址。"); };
  current.onclose = () => {
    if (current !== socket) return;
    socket = undefined;
    setStatus("未连接：检查 Biny 是否运行，或重新复制配对地址。");
    // 只重连通道，不重发命令。
    retry = setTimeout(() => void connect(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
    cleanup = Promise.all([...attached].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
    attached.clear(); dialogs.clear(); contexts.clear();
  };
}

chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); dialogs.delete(tabId); contexts.delete(tabId); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId } = source;
  const current = socket;
  void trackFrameEvent(chrome, { attached, contexts, connected: () => current === socket && current?.readyState === WebSocket.OPEN }, source, method, params).catch(() => { if (current === socket) current?.close(); });
  if (method === "Page.javascriptDialogOpening") dialogs.add(tabId);
  if (method === "Page.javascriptDialogClosed") dialogs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); dialogs.delete(tabId); contexts.delete(tabId); });
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "status") reply({ status });
  if (message.type === "reconnect") {
    generation++;
    const previous = socket; socket = undefined; previous?.close(); clearTimeout(retry);
    cleanup = Promise.all([...attached].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
    attached.clear(); dialogs.clear(); contexts.clear();
    void connect(); reply({ status: "连接中" });
  }
});
chrome.alarms.create("biny-relay", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => { if (name === "biny-relay") void connect(); });
void connect();
