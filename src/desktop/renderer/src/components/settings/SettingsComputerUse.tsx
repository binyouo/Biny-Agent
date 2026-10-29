import { useEffect, useRef, useState } from "react";
import type { ComputerDesktopApi, ComputerDiagnostics, ComputerPermissionState, ComputerStatus } from "../../../../../computer/protocol.js";
import { Icon } from "../Icon.js";
declare global { interface Window { binyComputer: ComputerDesktopApi } }
import { SettingsSwitch } from "./SettingsSwitch.js";
const restartMessage = "桌面控制组件尚未就绪，请完全退出并重新启动 Biny。";
const permissionLabels: Record<ComputerPermissionState, string> = { granted: "已授权", denied: "未授权", unknown: "未知" };
function relativeUseTime(value?: string): string {
  if (!value) return "从未";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)} 小时前`;
  return `${Math.round(elapsed / 86_400_000)} 天前`;
}
function PermissionRow({ name, label, state }: { name: string; label: string; state: ComputerPermissionState }): React.JSX.Element {
  return <div className="cu-permission" data-permission={name}><span>{label}</span><span className={`cu-permission-state is-${state}`}><span className="cu-sr-only">{permissionLabels[state]}</span><Icon name={state === "granted" ? "circle-check" : state === "denied" ? "close" : "help"} size={17} /></span></div>;
}
function RevokeDialog({ bundle, busy, error, onClose, onConfirm }: { bundle: string; busy: boolean; error: string; onClose(): void; onConfirm(): void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal(); element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="cu-confirm" role="alertdialog" aria-labelledby="cu-revoke-title" aria-describedby="cu-revoke-description" data-confirm-revoke={bundle} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h4 id="cu-revoke-title">撤销该应用的授权？</h4><p id="cu-revoke-description" className="cu-muted">撤销 <code className="cu-path">{bundle}</code> 的授权。严格审批开启时，重新批准前将无法操作；关闭严格审批时，下次使用会自动授权。</p>
    {error ? <p role="alert" className="cu-feedback">{error}</p> : null}
    <div className="cu-confirm-actions"><button type="button" className="settings-secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="settings-secondary-button is-danger" disabled={busy} onClick={onConfirm}>确认撤销</button></div>
  </dialog>;
}
export function SettingsComputerUse({ active = true }: { active?: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<ComputerStatus>();
  const [diagnostic, setDiagnostic] = useState<ComputerDiagnostics>();
  const [tested, setTested] = useState(false);

  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [diagnosticError, setDiagnosticError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const pendingDiagnostics = useRef(false);
  const diagnosticVersion = useRef(0);
  const diagnosticRead = useRef(0);
  const diagnosticApplied = useRef(0);
  const statusVersion = useRef(0);
  const permissionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useRef(active);
  const api = window.binyComputer;
  const available = [api?.status, api?.enable, api?.control, api?.preview, api?.logging, api?.diagnostics, api?.requestAccessibility, api?.testSetup, api?.strict, api?.approve, api?.revoke].every(method => typeof method === "function");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    if (!active) return;
    if (!available) { setError(restartMessage); return; }
    ++diagnosticVersion.current;
    let cancelled = false;
    let statusRequest = 0, statusApplied = 0;
    let diagnosticPending = false;
    const refreshStatus = (): void => {
      if (pending.current) return;
      const version = statusVersion.current, request = ++statusRequest;
      void api.status().then(value => {
        if (!cancelled && !pending.current && statusVersion.current === version && request > statusApplied) { statusApplied = request; setStatus(value); }
      }).catch(reason => {
        if (!cancelled && !pending.current && statusVersion.current === version && request > statusApplied) { statusApplied = request; setError(String(reason)); }
      });
    };
    const refreshDiagnostic = (): void => {
      if (pendingDiagnostics.current || diagnosticPending) return;
      diagnosticPending = true;
      const version = diagnosticVersion.current, request = ++diagnosticRead.current;
      void api.diagnostics().then(value => {
        if (!cancelled && !pendingDiagnostics.current && diagnosticVersion.current === version && request > diagnosticApplied.current) {
          diagnosticApplied.current = request; setDiagnostic(value); setDiagnosticError("");
        }
      }).catch(reason => {
        if (!cancelled && !pendingDiagnostics.current && diagnosticVersion.current === version && request > diagnosticApplied.current) {
          diagnosticApplied.current = request; setDiagnosticError(reason instanceof Error ? reason.message : String(reason));
        }
      }).finally(() => { diagnosticPending = false; });
    };
    refreshStatus();
    refreshDiagnostic();
    const timer = setInterval(refreshStatus, 1500);
    const diagnosticTimer = setInterval(refreshDiagnostic, 15_000);
    return () => { cancelled = true; clearInterval(timer); clearInterval(diagnosticTimer); if (permissionTimer.current) clearTimeout(permissionTimer.current); permissionTimer.current = undefined; };
  }, [active, api, available]);
  const perform = async (action: () => Promise<void>, updatesDiagnostics = true): Promise<void> => {
    if (pending.current || !available) return;
    pending.current = true; pendingDiagnostics.current = updatesDiagnostics; if (updatesDiagnostics) diagnosticVersion.current++; statusVersion.current++; setBusy(true); setError("");
    try { await action(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (updatesDiagnostics) diagnosticVersion.current++; pendingDiagnostics.current = false; pending.current = false; if (mounted.current) setBusy(false); }
  };
  const updateStatus = async (action: () => Promise<ComputerStatus>): Promise<void> => { const value = await action(); if (mounted.current) setStatus(value); };
  const readDiagnostic = async (action = () => api.diagnostics()): Promise<void> => { const value = await action(); if (mounted.current) { setDiagnostic(value); setDiagnosticError(""); } };
  const requestAccessibility = async (): Promise<void> => {
    await readDiagnostic(() => api.requestAccessibility());
    if (!mounted.current || !activeRef.current) return;
    if (permissionTimer.current) clearTimeout(permissionTimer.current);
    permissionTimer.current = setTimeout(() => {
      permissionTimer.current = undefined;
      const version = diagnosticVersion.current, request = ++diagnosticRead.current;
      void api.diagnostics().then(value => { if (mounted.current && activeRef.current && !pendingDiagnostics.current && diagnosticVersion.current === version && request > diagnosticApplied.current) { diagnosticApplied.current = request; setDiagnostic(value); setDiagnosticError(""); } }).catch(reason => { if (mounted.current && activeRef.current && !pendingDiagnostics.current && diagnosticVersion.current === version && request > diagnosticApplied.current) { diagnosticApplied.current = request; setDiagnosticError(reason instanceof Error ? reason.message : String(reason)); } });
    }, 2500);
  };
  const unavailable = busy || !available;
  const permission = diagnostic?.permissions;
  const helperPresent = diagnostic?.helperPresent ?? diagnostic?.sdkLoaded ?? false;
  return <div className="settings-sections computer-use-settings">
    <div className="settings-row-group cu-toggles">
      <SettingsSwitch label="桌面控制" checked={Boolean(status && status.state !== "disabled")} disabled={unavailable || !status} detail="首次使用时启动；关闭会停止控制。" onChange={value => void perform(async () => { await updateStatus(() => value ? api.enable() : api.control("stop")); await readDiagnostic(); })} />
    </div>
    <section className="cu-card">
      <h3 className="cu-title"><Icon name="cpu" size={16} />Computer Use</h3>
      <p className="cu-description">在后台操作原生 Mac 应用，需要桌面控制组件及 macOS 权限。截图会发送给当前模型。</p>
      <div className="cu-section"><h4>桌面控制组件</h4><div className="cu-helper" data-loaded={helperPresent}>
        <Icon name={helperPresent ? "circle-check" : "help"} size={17} />
        <strong className={helperPresent ? "cu-path" : undefined}>{!diagnostic ? "正在检查…" : helperPresent ? diagnostic.workerPath : "未找到"}</strong><span>{helperPresent ? `已安装${diagnostic?.driverVersion ? ` · v${diagnostic.driverVersion}` : ""}` : ""}</span>
      </div></div>
      <div className="cu-section"><h4>权限</h4><div className="cu-permission-grid">
        <PermissionRow name="accessibility" label="辅助功能" state={permission?.accessibility ?? "unknown"} />
        <PermissionRow name="screenRecording" label="屏幕录制" state={permission?.screenRecording ?? "unknown"} />
      </div>{diagnostic?.focusGuard === "unavailable" ? (
        <section className="cu-focus-warning" data-focus-guard="unavailable">
          <Icon name="shield" size={14} /><div><h4>焦点保护未生效</h4><p className="cu-description">后台输入不可用。请重新授予辅助功能权限后重试。</p></div>
        </section>
      ) : null}<div className="cu-button-row">
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(requestAccessibility)}><Icon name="shield" size={14} />授权辅助功能</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { await readDiagnostic(); await updateStatus(() => api.status()); })}><Icon name="refresh" size={14} />刷新</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { setTested(false); await readDiagnostic(() => api.testSetup()); await updateStatus(() => api.status()); if (mounted.current) setTested(true); })}><Icon name="eye" size={14} />测试我的配置</button>
      </div>
      {error || diagnosticError || diagnostic?.error || status?.diagnostic ? <p className="cu-feedback" role="alert">{!available ? restartMessage : "桌面控制暂不可用，请刷新或重新授权后重试。"}</p> : tested ? (
        <ul className="cu-feedback cu-checkup" role="status">
          <li data-check="helper" data-ok={Boolean(diagnostic?.sdkLoaded)}>
            {diagnostic?.sdkLoaded ? `✓ 原生 daemon v${diagnostic.driverVersion ?? "?"} 运行中（已运行 ${diagnostic.uptimeSeconds ?? 0}s）` : "✗ 原生 daemon 未加载"}
          </li>
          <li data-check="accessibility" data-ok={permission?.accessibility === "granted"}>
            {permission?.accessibility === "granted" ? "✓ 辅助功能已授权" : "✗ 辅助功能未授权"}
          </li>
          <li data-check="screenRecording" data-ok={permission?.screenRecording === "granted"}>
            {permission?.screenRecording === "granted" ? "✓ 屏幕录制已授权" : "✗ 屏幕录制未授权"}
          </li>
        </ul>
      ) : null}
      </div>
      <div className="settings-row-group cu-toggles">
        <div className="cu-toggle"><Icon name="lock" size={14} /><SettingsSwitch label="严格应用审批" checked={diagnostic?.strictApproval ?? false} disabled={unavailable || !diagnostic} detail="仅允许已批准的应用；关闭时首次使用自动授权。" onChange={value => void perform(() => readDiagnostic(() => api.strict(value)))} /></div>
        <div className="cu-toggle"><Icon name="shield" size={14} /><SettingsSwitch label="记录操作日志" checked={status?.actionLogging ?? false} disabled={unavailable || !status} detail="本地记录动作与结果，不保存输入或截图。" onChange={value => void perform(() => updateStatus(() => api.logging(value)), false)} /></div>
        <div className="cu-toggle"><Icon name="eye" size={14} /><SettingsSwitch label="画中画" checked={status?.preview ?? false} disabled={unavailable || !status} detail="操控时在桌面与全屏空间悬浮显示，空闲自动收起；显示期间暂停活动截图。" onChange={value => void perform(() => updateStatus(() => api.preview(value)), false)} /></div>
      </div>

    </section>
      <section className="cu-card cu-approvals"><div className="cu-approvals-heading"><h3>应用授权（{diagnostic?.approvals.length ?? 0}）</h3><button type="button" className="settings-secondary-button" aria-label="刷新应用授权" disabled={unavailable} onClick={() => void perform(() => readDiagnostic())}><Icon name="refresh" size={14} /></button></div>
        <p className="cu-muted">严格模式下在此批准应用。关闭严格审批后，撤销的应用会在下次使用时自动重新授权。</p>
        {!diagnostic?.approvals.length ? <p className="cu-muted">尚无应用授权记录。</p> : diagnostic.approvals.map(app => {
          const approved = Boolean(app.approvedAt && !app.revokedAt);
          return <div className="cu-permission cu-approval-row" key={app.bundleId} data-app={app.bundleId}>
            <div className="cu-approval-info"><strong>{app.appName}</strong><p className="cu-muted">{app.bundleId} · {approved ? "已批准" : app.revokedAt ? "已撤销" : "待批准"}</p></div>
            <div className="cu-approval-actions"><p className="cu-muted">使用 {app.useCount} 次 · 最近 {relativeUseTime(app.lastUsedAt)}</p><button type="button" className={`settings-secondary-button${approved ? " is-danger" : ""}`} disabled={unavailable} onClick={() => { if (approved) { setError(""); setConfirmRevoke(app.bundleId); } else void perform(() => readDiagnostic(() => api.approve(app.bundleId))); }}>{approved ? "撤销授权" : "批准应用"}</button></div>
          </div>;
        })}
      </section>
      {confirmRevoke ? <RevokeDialog bundle={confirmRevoke} busy={busy} error={error} onClose={() => setConfirmRevoke(null)} onConfirm={() => void perform(async () => { await readDiagnostic(() => api.revoke(confirmRevoke)); if (mounted.current) setConfirmRevoke(null); })} /> : null}

  </div>;
}
