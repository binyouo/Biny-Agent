/** 浏览器配对由主进程管理；安装与配对操作即时生效。 */
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../../../protocol.js";
import { redactSecrets } from "../../../../../utils/redaction.js";
import { Icon } from "../Icon.js";

type ConnectionState =
  | { kind: "loading" }
  | { kind: "ready"; status: Awaited<ReturnType<DesktopApi["browserRelayStatus"]>> }
  | { kind: "error"; message: string; restartRequired: boolean };
type BrowserAction = "install" | "open-chrome" | "pair" | "regenerate" | "disconnect";
const restartMessage = "浏览器连接接口尚不可用，请完全退出并重新启动 Biny。";

export function SettingsBrowser(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>({ kind: "loading" });
  const [busy, setBusy] = useState<BrowserAction>();
  const [confirmation, setConfirmation] = useState<"regenerate" | "disconnect">();
  const [extensionPath, setExtensionPath] = useState("");
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
      if (![api?.browserRelayStatus, api?.browserRelayInstall, api?.browserRelayOpenChrome, api?.browserRelaySetup, api?.browserRelayDisconnect].every(method => typeof method === "function")) {
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
        if (typeof status?.running !== "boolean" || typeof status.connected !== "boolean" || !Array.isArray(status.browsers)
          || (status.connected && !status.running) || status.connected !== (status.browsers.length > 0)
          || status.browsers.some(browser => typeof browser?.browserId !== "string" || typeof browser.browserName !== "string")) throw new Error("连接状态无效");
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

  const perform = async (action: BrowserAction): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action); setConfirmation(undefined); setActionError(""); setNotice("");
    try {
      let message: string;
      if (action === "install") {
        const result = await window.biny.browserRelayInstall();
        if (mounted.current) setExtensionPath(result.extensionPath);
        message = "扩展目录已打开。在 Chrome 中开启开发者模式，选择「加载已解压的扩展程序」并加载此目录。";
      } else if (action === "open-chrome") {
        await window.biny.browserRelayOpenChrome();
        message = "Chrome 扩展管理已打开。加载扩展后，继续复制配对地址。";
      } else if (action === "disconnect") {
        await window.biny.browserRelayDisconnect();
        message = "连接已撤销，旧配对地址已失效。";
      } else {
        const result = await window.biny.browserRelaySetup(action === "regenerate");
        if (mounted.current) setExtensionPath(result.extensionPath);
        message = action === "regenerate" ? "新配对地址已复制，旧配对地址已失效。请在各 Chrome 配置的扩展设置中重新连接。"
          : "配对地址已复制。在扩展设置中粘贴地址，选择「保存并连接」；连接结果会显示在上方。";
      }
      if (mounted.current) setNotice(message);
    } catch (reason) {
      if (mounted.current) setActionError(/No handler registered|not a function/.test(String(reason)) ? restartMessage : redactSecrets(reason instanceof Error ? reason.message : String(reason)));
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(undefined); setRefresh(value => value + 1); }
    }
  };
  const refreshStatus = (): void => { setConnection({ kind: "loading" }); setRefresh(value => value + 1); };
  const disabled = busy !== undefined || (connection.kind === "error" && connection.restartRequired);
  const connected = connection.kind === "ready" && connection.status.connected;
  const installGuide = <>
    <p>在日常使用的 Chrome（125 或更新版本）中安装扩展，连接已有网页与登录状态。</p>
    <div className="settings-button-row">
      <button type="button" className="settings-secondary-button" disabled={disabled} onClick={() => void perform("install")}><Icon name="folder" size={14} />{busy === "install" ? "打开中…" : "打开扩展目录"}</button>
      <button type="button" className="settings-secondary-button" disabled={disabled} onClick={() => void perform("open-chrome")}><Icon name="external" size={14} />{busy === "open-chrome" ? "启动中…" : "打开 Chrome 扩展管理"}</button>
    </div>
    {extensionPath ? <code className="browser-extension-path" aria-label="扩展目录">{extensionPath}</code> : null}
    <ol>
      <li>在 <code>chrome://extensions/</code> 右上角开启“开发者模式”。</li>
      <li>选择“加载已解压的扩展程序”，加载上方打开的目录。</li>
      <li>点击 Biny Browser Relay 的扩展图标，打开扩展设置。</li>
    </ol>
  </>;
  return <div className="settings-sections browser-connection-settings" onKeyDown={event => {
    if (confirmation && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setConfirmation(undefined); }
  }}>
    <section aria-labelledby="browser-connection-title">
      <div className="browser-connection-heading"><h3 id="browser-connection-title"><Icon name="globe" size={17} />连接状态</h3>
        <button type="button" className="settings-secondary-button" disabled={busy !== undefined || connection.kind === "loading"} onClick={refreshStatus}><Icon name="refresh" size={14} />刷新状态</button>
      </div>
      {connection.kind === "error" ? <p role="alert">{connection.message} <button type="button" className="settings-secondary-button" disabled={busy !== undefined} onClick={refreshStatus}>重试</button></p>
        : <p role="status" className={`browser-connection-status${connected ? " is-connected" : ""}`}><span aria-hidden="true" />{connection.kind === "loading" ? "正在读取连接状态…" : !connection.status.running ? "连接服务未启动，复制配对地址时会启动服务。" : connection.status.connected ? `${connection.status.browsers.map(browser => browser.browserName).join("、")} 已连接` : "Chrome 扩展未连接"}</p>}
    </section>
    {connected ? <details className="settings-disclosure settings-install-guide browser-install-guide"><summary>安装到其他 Chrome 配置</summary>{installGuide}</details>
      : <section className="settings-install-guide browser-install-guide"><h3>1. 安装扩展</h3>{installGuide}</section>}
    <section aria-labelledby="browser-pairing-title">
      <h3 id="browser-pairing-title">{connected ? "配对管理" : "2. 连接 Biny"}</h3>
      <p>复制配对地址，在扩展设置中粘贴并选择“保存并连接”。地址包含访问凭据，请保密。</p>
      <div className="settings-button-row">
        <button type="button" className="settings-primary-button" disabled={disabled || connection.kind === "loading"} onClick={() => void perform("pair")}><Icon name="copy" size={14} />{busy === "pair" ? "复制中…" : "复制配对地址"}</button>
        <button type="button" className="settings-secondary-button" disabled={disabled || connection.kind === "loading"} onClick={() => setConfirmation("regenerate")}><Icon name="refresh" size={14} />{busy === "regenerate" ? "重新生成中…" : "重新生成配对地址"}</button>
        <button type="button" className="settings-secondary-button is-danger" disabled={disabled || connection.kind !== "ready" || !connection.status.running} onClick={() => setConfirmation("disconnect")}>撤销全部连接</button>
      </div>
      {confirmation ? <div className="browser-pairing-confirm" role="group" aria-labelledby="browser-confirm-title">
        <p id="browser-confirm-title">{confirmation === "regenerate" ? "重新生成会断开全部 Chrome 配置，旧配对地址立即失效。继续并复制新地址？" : "撤销会断开全部 Chrome 配置，旧配对地址立即失效。确认撤销？"}</p>
        <div className="settings-button-row"><button autoFocus type="button" className="settings-secondary-button" onClick={() => setConfirmation(undefined)}>取消</button>
          <button type="button" className="settings-secondary-button is-danger" onClick={() => void perform(confirmation)}>{confirmation === "regenerate" ? "确认并复制新地址" : "确认撤销"}</button></div>
      </div> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <details className="settings-disclosure"><summary>多个 Chrome 配置与连接范围</summary>
        <p>最多同时连接 8 个 Chrome 配置。每个配置需分别安装扩展、粘贴配对地址，并填写不同的连接名称。</p>
        <p>连接覆盖该 Chrome 配置的普通网页；重新生成地址或撤销连接会影响全部已配对配置。</p>
      </details>
    </section>
  </div>;
}
