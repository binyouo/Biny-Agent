/** 浏览器连接是应用内置能力；此页管理 Chrome 扩展配对，操作即时生效。 */
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../../../protocol.js";

type ConnectionState =
  | { kind: "loading" }
  | { kind: "ready"; status: Awaited<ReturnType<DesktopApi["browserRelayStatus"]>> }
  | { kind: "error"; message: string; restartRequired: boolean };
const restartMessage = "浏览器连接接口尚不可用，请完全退出并重新启动 Biny。";

export function SettingsBrowser(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cancelRead: (() => void) | undefined;
    const update = async (): Promise<void> => {
      const api = window.biny;
      if (!api || typeof api.browserRelayStatus !== "function" || typeof api.browserRelaySetup !== "function" || typeof api.browserRelayDisconnect !== "function") {
        setConnection({ kind: "error", message: restartMessage, restartRequired: true });
        return;
      }
      try {
        const status = await Promise.race([
          api.browserRelayStatus(),
          new Promise<never>((_resolve, reject) => {
            cancelRead = () => reject(new Error("设置页已离开"));
            deadline = setTimeout(() => reject(new Error("连接状态读取超时")), 5000);
          })
        ]);
        if (typeof status?.running !== "boolean" || typeof status.connected !== "boolean" || !Array.isArray(status.browsers) || (status.connected && !status.running)) throw new Error("连接状态无效");
        if (!cancelled) {
          setConnection({ kind: "ready", status });
          // 仅在有效状态下刷新；桥接故障停止轮询，由用户重试，避免持续发出失败请求。
          timer = setTimeout(() => void update(), 3000);
        }
      } catch (reason) {
        if (!cancelled) {
          const restartRequired = /No handler registered|not a function/.test(String(reason));
          setConnection({ kind: "error", message: restartRequired ? restartMessage : "无法读取连接状态，请重试；若仍失败，请完全退出并重新启动 Biny。", restartRequired });
        }
      } finally { clearTimeout(deadline); cancelRead = undefined; }
    };
    void update();
    return () => { cancelled = true; cancelRead?.(); clearTimeout(timer); clearTimeout(deadline); };
  }, [busy, refresh]);

  const perform = async (disconnect: boolean): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setActionError(""); setNotice("");
    try {
      if (disconnect) await window.biny.browserRelayDisconnect();
      else await window.biny.browserRelaySetup();
      if (mounted.current) setNotice(disconnect ? "连接已撤销，旧配对地址已失效。" : "配对地址已复制，扩展目录已打开。请在 Chrome 扩展设置中粘贴地址并连接。");
    } catch (reason) {
      if (mounted.current) setActionError(/No handler registered|not a function/.test(String(reason)) ? restartMessage : String(reason));
    } finally { pending.current = false; if (mounted.current) { setBusy(false); setRefresh((value) => value + 1); } }
  };
  const unavailable = connection.kind === "error" && connection.restartRequired;
  return <div className="settings-sections browser-connection-settings">
    <section>
      <h3>Chrome 浏览器</h3>
      <p>通过扩展连接日常 Chrome（125 或更新版本），读取已有标签并使用当前登录状态。</p>
      {connection.kind === "error" ? <p role="alert">{connection.message} <button type="button" className="settings-secondary-button" disabled={busy} onClick={() => { setConnection({ kind: "loading" }); setRefresh((value) => value + 1); }}>重试</button></p>
        : <p role="status">{connection.kind === "loading" ? "正在读取连接状态…" : !connection.status.running ? "连接服务未启动，可点击下方按钮启动并配对。" : connection.status.connected ? `${connection.status.browsers.map((browser) => browser.browserName).join("、")} 已连接` : "Chrome 扩展未连接"}</p>}
      <div className="settings-button-row">
        <button type="button" className="settings-secondary-button" disabled={busy || unavailable || connection.kind === "loading"} onClick={() => void perform(false)}>{busy ? "处理中…" : "复制配对地址并打开扩展目录"}</button>
        <button type="button" className="settings-secondary-button" disabled={busy || connection.kind !== "ready" || !connection.status.running} onClick={() => void perform(true)}>撤销全部连接</button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
    </section>
    <section>
      <h3>安装 Chrome 扩展</h3>
      <ol>
        <li>打开 <code>chrome://extensions</code>，开启“开发者模式”。</li>
        <li>点击上方配对按钮，然后选择“加载已解压的扩展程序”，加载刚打开的目录。</li>
        <li>打开 Biny Browser Relay 扩展设置，粘贴配对地址，选择“保存并连接”。</li>
      </ol>
      <p>扩展安装在当前 Chrome 配置中，可同时连接最多 8 个配置；请在各扩展设置中填写不同名称。配对地址包含访问凭据，请勿发送到聊天中。</p>
      <p>连接与撤销立即生效，无需保存设置。撤销将断开所有配置，旧配对地址同时失效。</p>
    </section>
    <section>
      <h3>内置浏览器</h3>
      <p>项目侧栏的内置浏览器用于网页浏览和项目预览，使用独立的标签与登录状态。Chrome 扩展连接由本页管理。</p>
    </section>
  </div>;
}
