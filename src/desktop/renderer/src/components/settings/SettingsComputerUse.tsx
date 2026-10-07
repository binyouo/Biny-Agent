import { useEffect, useRef, useState } from "react";
import type { ComputerControl, ComputerDesktopApi, ComputerDiagnostics, ComputerPermissionState, ComputerStatus } from "../../../../../computer/protocol.js";
import { Icon } from "../Icon.js";
declare global { interface Window { binyComputer: ComputerDesktopApi } }
import { SettingsSwitch } from "./SettingsSwitch.js";
const restartMessage = "桌面控制组件尚未就绪，请完全退出并重新启动 Biny。";
const stateLabels: Record<ComputerStatus["state"], string> = { disabled: "未启用", ready: "已启用", paused: "已暂停", "taken-over": "人工接管中", unknown: "动作结果未知，先检查目标窗口" };
const outcomeLabels: Record<ComputerStatus["lastOutcome"], string> = { "not-dispatched": "尚未派发", completed: "输入已完成", refused: "已拒绝", unverified: "效果未确认", unknown: "输入结果未知" };
const permissionLabels: Record<ComputerPermissionState, string> = { granted: "已授权", denied: "未授权", unknown: "未知" };
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
export function SettingsComputerUse(): React.JSX.Element {
  const [status, setStatus] = useState<ComputerStatus>();
  const [diagnostic, setDiagnostic] = useState<ComputerDiagnostics>();
  const [tested, setTested] = useState(false);

  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const api = window.binyComputer;
  const available = [api?.status, api?.enable, api?.control, api?.preview, api?.foreground, api?.logging, api?.diagnostics, api?.requestAccessibility, api?.testSetup, api?.strict, api?.approve, api?.revoke].every(method => typeof method === "function");
  useEffect(() => {
    mounted.current = true;
    if (!available) { setError(restartMessage); return () => { mounted.current = false; }; }
    const refreshStatus = (): void => {
      if (pending.current) return;
      void api.status().then(value => { if (mounted.current && !pending.current) setStatus(value); }).catch(reason => { if (mounted.current) setError(String(reason)); });
    };
    refreshStatus();
    void api.diagnostics().then(value => { if (mounted.current) setDiagnostic(value); }).catch(reason => { if (mounted.current) setError(String(reason)); });
    const timer = setInterval(refreshStatus, 1500);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [api, available]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current || !available) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const updateStatus = async (action: () => Promise<ComputerStatus>): Promise<void> => { const value = await action(); if (mounted.current) setStatus(value); };
  const readDiagnostic = async (action = () => api.diagnostics()): Promise<void> => { const value = await action(); if (mounted.current) setDiagnostic(value); };
  const control = (value: ComputerControl): void => { void perform(async () => { await updateStatus(() => api.control(value)); await readDiagnostic(); }); };
  const unavailable = busy || !available;
  const permission = diagnostic?.permissions;
  const helperPresent = diagnostic?.helperPresent ?? diagnostic?.sdkLoaded ?? false;
  const diagnosticText = [
    diagnostic?.runtimeReady ? `✓ 原生运行时已就绪（v${diagnostic.driverVersion ?? "未知"}）` : helperPresent ? "✓ 原生组件已安装；运行时按需启动" : "✗ 原生组件未找到",
    `辅助功能：${permissionLabels[permission?.accessibility ?? "unknown"]}`,
    `屏幕录制：${permissionLabels[permission?.screenRecording ?? "unknown"]}`,
    "配置测试只检查运行时、版本和权限，不截图、不输入。",
    diagnostic ? `宿主：${diagnostic.hostPath}` : "",
    error,
    diagnostic?.error ?? "",
    status?.diagnostic ?? ""
  ].filter(Boolean).join("\n");
  return <div className="settings-sections computer-use-settings">
    <section className="cu-card">
      <h3 className="cu-heading"><Icon name="cpu" size={17} />Computer Use</h3>
      <p className="cu-description">在后台操作 Mac 应用。需要系统授权，截图会发送给当前模型。</p>
      <div className="settings-row-group cu-toggles">
        <SettingsSwitch label="桌面控制" checked={Boolean(status && status.state !== "disabled")} disabled={unavailable || !status} detail="首次使用时启动；关闭会停止控制。" onChange={value => void perform(async () => { await updateStatus(() => value ? api.enable() : api.control("stop")); await readDiagnostic(); })} />
      </div>
      <div className="cu-section"><h4>桌面控制组件</h4><div className="cu-helper" data-loaded={helperPresent}>
        <Icon name={helperPresent ? "circle-check" : "help"} size={17} />
        <strong>{!diagnostic ? "正在检查…" : helperPresent ? "已安装" : "未找到"}</strong><span>{diagnostic?.runtimeReady ? "运行中" : helperPresent ? "按需启动" : ""}</span>
      </div></div>
      <div className="cu-section"><h4>权限</h4><div className="cu-permission-grid">
        <PermissionRow name="accessibility" label="辅助功能" state={permission?.accessibility ?? "unknown"} />
        <PermissionRow name="screenRecording" label="屏幕录制" state={permission?.screenRecording ?? "unknown"} />
      </div><div className="cu-button-row">
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(() => readDiagnostic(() => api.requestAccessibility()))}><Icon name="shield" size={14} />授权辅助功能</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { await readDiagnostic(); await updateStatus(() => api.status()); })}><Icon name="refresh" size={14} />刷新</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { setTested(false); await readDiagnostic(() => api.testSetup()); await updateStatus(() => api.status()); if (mounted.current) setTested(true); })}><Icon name="eye" size={14} />测试我的配置</button>
      </div>
      {error || diagnostic?.error || status?.diagnostic ? <p className="cu-feedback" role="alert">{!available ? restartMessage : "桌面控制暂不可用，请查看诊断详情。"}</p> : tested ? (
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
        <SettingsSwitch label="严格应用审批" checked={diagnostic?.strictApproval ?? false} disabled={unavailable || !diagnostic} detail="仅允许已批准的应用；关闭时首次使用自动授权。" onChange={value => void perform(() => readDiagnostic(() => api.strict(value)))} />
        <SettingsSwitch label="记录操作日志" checked={status?.actionLogging ?? false} disabled={unavailable || !status} detail="本地记录动作与结果，不保存输入或截图。" onChange={value => void perform(() => updateStatus(() => api.logging(value)))} />
        <SettingsSwitch label="画中画" checked={status?.preview ?? false} disabled={unavailable || !status} detail="操控时显示预览，空闲自动收起；显示期间暂停活动截图。" onChange={value => void perform(() => updateStatus(() => api.preview(value)))} />
      </div>
      {diagnostic?.focusGuard === "unavailable" ? (
        <section className="cu-section" data-focus-guard="unavailable">
          <h4>焦点保护未生效</h4>
          <p className="cu-description">动作可能切换前台应用。请重新授予辅助功能权限后重试。</p>
        </section>
      ) : null}
      <details className="cu-controls"><summary>高级设置</summary><div className="cu-section"><p role="status">{status ? `${stateLabels[status.state]} · ${outcomeLabels[status.lastOutcome]}` : "正在读取控制状态…"}</p><div className="cu-button-row">
        <button type="button" className="settings-secondary-button" disabled={unavailable || status?.state !== "ready"} onClick={() => control("pause")}><Icon name="pause" size={14} />暂停</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || !status || status.state === "ready" || status.state === "disabled"} onClick={() => control("resume")}><Icon name="play" size={14} />继续（需重新观察）</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || !status || status.state === "disabled"} onClick={() => control("takeover")}>人工接管</button>
      </div><p className="cu-muted">暂停或接管会取消等待操作。已派发的输入可能无法撤回；继续前重新观察，不自动重放。</p>
      <label className="cu-foreground"><input type="checkbox" disabled={unavailable || !status} checked={status?.foregroundAllowed ?? false} onChange={event => void perform(() => updateStatus(() => api.foreground(event.target.checked)))} />允许明确批准的前台动作（可能改变焦点）</label>
        <p className="cu-muted">日志共 {diagnostic?.audit.length ?? 0} 条，点击“刷新”读取最新元数据。</p>
        {diagnostic?.audit.length ? <pre className="cu-diagnostics">{diagnostic.audit.map(entry => [
              new Date(entry.at).toLocaleTimeString(),
              entry.action,
              entry.bundleId ?? `PID ${entry.target.pid}`,
              outcomeLabels[entry.outcome],
              `${entry.durationMs}ms`,
              entry.errorCode ? `· ${entry.errorCode}` : ""
            ].filter(Boolean).join(" ")).join("\n")}</pre> : null}
      </div></details>
      <details className="cu-technical-details"><summary>诊断详情</summary>
        {diagnostic?.actionLimits?.map(limit => <p className="cu-description" data-action-limit={limit.action} key={limit.code}>{limit.message}</p>)}
        <pre className="cu-diagnostics">{diagnosticText}{diagnostic ? <>{"\n组件："}<code className="cu-path">{diagnostic.workerPath}</code>{diagnostic.driverVersion ? `\n版本：${diagnostic.driverVersion}` : ""}{typeof diagnostic.uptimeSeconds === "number" ? `\n运行时长：${diagnostic.uptimeSeconds} 秒` : ""}{!helperPresent ? "\n开发环境可运行 pnpm build:activity-sidecar 重建组件。" : ""}</> : null}</pre>
      </details>

    </section>
      <section className="cu-card cu-approvals"><h3>应用授权（{diagnostic?.approvals.length ?? 0}）</h3>
        <p className="cu-muted">严格模式下在此批准应用。关闭严格审批后，撤销的应用会在下次使用时自动重新授权。</p>
        {!diagnostic?.approvals.length ? <p className="cu-muted">尚无应用授权记录。</p> : diagnostic.approvals.map(app => {
          const approved = Boolean(app.approvedAt && !app.revokedAt);
          return <div className="cu-permission" key={app.bundleId} data-app={app.bundleId}>
            <div><strong>{app.appName}</strong><p className="cu-muted">{app.bundleId} · {approved ? "已批准" : app.revokedAt ? "已撤销" : "待批准"}</p></div>
            <button type="button" className={`settings-secondary-button${approved ? " is-danger" : ""}`} disabled={unavailable} onClick={() => { if (approved) { setError(""); setConfirmRevoke(app.bundleId); } else void perform(() => readDiagnostic(() => api.approve(app.bundleId))); }}>{approved ? "撤销授权" : "批准应用"}</button>
          </div>;
        })}
      </section>
      {confirmRevoke ? <RevokeDialog bundle={confirmRevoke} busy={busy} error={error} onClose={() => setConfirmRevoke(null)} onConfirm={() => void perform(async () => { await readDiagnostic(() => api.revoke(confirmRevoke)); if (mounted.current) setConfirmRevoke(null); })} /> : null}

  </div>;
}
