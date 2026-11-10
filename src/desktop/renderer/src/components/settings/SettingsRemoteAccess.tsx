import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { RemoteAccessStatus } from "../../../../../remote/access.js";
import { Icon } from "../Icon.js";
import "./remote-access.css";

export function SettingsRemoteAccess({ active }: { active: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<RemoteAccessStatus>();
  const [relay, setRelay] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qr, setQr] = useState<{ link: string; image: string }>();
  const readVersion = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const read = async (): Promise<void> => {
    const version = ++readVersion.current;
    try {
      const next = await window.biny.remoteAccessStatus();
      if (!mounted.current || version !== readVersion.current) return;
      setStatus(next);
      setRelay(current => current || next.relay || "");
      setError("");
    } catch (cause) {
      if (mounted.current && version === readVersion.current) setError(cause instanceof Error ? cause.message : "无法读取连接状态。");
    }
  };
  useEffect(() => {
    mounted.current = active;
    if (!active) return;
    setBusy(pending.current);
    void read();
    const unsubscribe = window.biny.onRemoteAccessChanged(() => { void read(); });
    return () => { mounted.current = false; unsubscribe(); };
  }, [active]);

  const pairingUrl = !busy && !error && status?.state === "connected" ? status.pairingUrl : undefined;
  useEffect(() => {
    let cancelled = false;
    if (!pairingUrl) { setQr(undefined); return; }
    void QRCode.toString(pairingUrl, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 280 }).then(svg => {
      if (!cancelled) setQr({ link: pairingUrl, image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
    }).catch(() => { if (!cancelled) setError("二维码生成失败，请重试。"); });
    return () => { cancelled = true; };
  }, [pairingUrl]);

  const perform = async (work: () => Promise<unknown>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setNotice("");
    readVersion.current++;
    try { await work(); if (mounted.current) await read(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const enabled = status !== undefined && status.state !== "disabled";
  const labels = { disabled: "未开启", connecting: "正在连接中继…", connected: "中继已连接", reconnecting: "中继已断开，正在重连…", error: "连接失败" };
  return <div className="settings-sections remote-access-settings">
    <section className="settings-section"><div className="settings-section-body">
      <header className="remote-access-heading"><Icon name="phone" size={17} /><span className="remote-access-heading-copy"><h3>手机连接</h3><p>从手机访问这台 Biny 上的项目：查看会话、发送消息和处理授权。电脑需保持 Biny 运行；iOS 客户端尚未发布，配对信息供后续 App 扫码使用。</p></span></header>
      <form className="remote-access-form" onSubmit={event => {
        event.preventDefault();
        void perform(async () => { await window.biny.remoteAccessStart({ relay: relay.trim(), registrationKey: key.trim() || undefined }); setKey(""); });
      }}>
        <label className="remote-access-field"><span>中继地址</span>
          <input className="settings-field" type="url" required aria-label="中继地址" value={enabled ? status.relay ?? "" : relay} placeholder="https://relay.example.com" disabled={busy || enabled} onChange={event => setRelay(event.target.value)} spellCheck={false} />
        </label>
        {!enabled ? <label className="remote-access-field"><span>注册密钥（可选）</span>
          <input className="settings-field" type="password" aria-label="中继注册密钥" value={key} autoComplete="off" disabled={busy} onChange={event => setKey(event.target.value)} />
        </label> : null}
        <div className="remote-access-footer">
          <p role="status" className={`remote-access-state${status ? ` is-${status.state}` : ""}`}><span aria-hidden="true" />{status ? labels[status.state] : "正在读取连接状态…"}{status?.state === "connected" ? ` · ${status.connections ? `${status.connections} 台设备在线` : "等待手机连接"}` : ""}</p>
          {enabled ? <button type="button" className="settings-action settings-secondary-button" disabled={busy} aria-busy={busy} onClick={() => void perform(() => window.biny.remoteAccessStop())}><Icon name="power" size={14} />关闭远程访问</button>
            : <button type="submit" className="settings-action settings-primary-button" disabled={busy || !status || !relay.trim()} aria-busy={busy}><Icon name="power" size={14} />开启远程访问</button>}
        </div>
      </form>
      <div className="remote-access-e2e">
        <Icon name="shield" size={17} />
        <span className="remote-access-e2e-copy"><strong>端到端加密</strong><small>手机与这台电脑之间的流量全程加密，中继服务器只能看到密文。</small></span>
        <span className="remote-access-e2e-state"><Icon name="check" size={13} />始终开启</span>
      </div>
      {status?.error ? <p role="alert">{status.error}</p> : null}
      {error ? <p role="alert">{error} <button type="button" className="settings-action settings-text-action" disabled={busy} onClick={() => void read()}>重试</button></p> : null}
    </div></section>
    {pairingUrl ? <section className="settings-section"><div className="settings-section-body">
      <header className="remote-access-heading"><Icon name="qr" size={17} /><span className="remote-access-heading-copy"><h3>配对手机</h3><p>用手机相机扫码即可建立加密连接；二维码和链接包含密钥，只交予自己的手机。</p></span></header>
      <div className="remote-access-phones"><Icon name="phone" size={15} />{status?.connections ? <p className="is-online"><span aria-hidden="true" />{status.connections} 台设备在线</p> : <p>还没有手机连接过 — 用手机扫描下方二维码。</p>}</div>
      {qr?.link === pairingUrl ? <img className="remote-access-qr" src={qr.image} alt="Biny 手机配对二维码" /> : <div className="remote-access-qr" role="status">正在生成二维码…</div>}
      <div className="remote-access-link-row">
        <code title={pairingUrl}>{pairingUrl}</code>
        <button type="button" className="settings-action settings-primary-button" onClick={() => { void navigator.clipboard.writeText(pairingUrl).then(() => setNotice("配对链接已复制。")).catch(() => setError("复制失败，请重试。")); }}><Icon name="copy" size={14} />复制配对链接</button>
        <button type="button" className="settings-action settings-secondary-button" disabled={busy} onClick={() => void perform(() => window.biny.remoteAccessRegenerate())}><Icon name="refresh" size={14} />重新生成</button>
      </div>
      <p>配对链接拥有这台 Biny 上全部项目的控制权；重新生成即可吊销旧链接。</p>
      {notice ? <p role="status">{notice}</p> : null}
    </div></section> : null}
  </div>;
}
