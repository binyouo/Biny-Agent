import { useEffect, useRef, useState } from "react";
import type { ComputerControl, ComputerDesktopApi, ComputerDiagnostics, ComputerPermissionState, ComputerStatus } from "../../../../../computer/protocol.js";
import { Icon } from "../Icon.js";
declare global { interface Window { binyComputer: ComputerDesktopApi } }
import { SettingsSwitch } from "./SettingsSwitch.js";
const restartMessage = "桌面控制组件尚未就绪，请完全退出并重新启动 Biny。";
const stateLabels: Record<ComputerStatus["state"], string> = { disabled: "未启用", ready: "已就绪", paused: "已暂停", "taken-over": "人工接管中", unknown: "动作结果未知，先检查目标窗口" };
const outcomeLabels: Record<ComputerStatus["lastOutcome"], string> = { "not-dispatched": "尚未派发", completed: "输入已完成", refused: "已拒绝", unverified: "效果未确认", unknown: "输入结果未知" };
const permissionLabels: Record<ComputerPermissionState, string> = { granted: "已授权", denied: "未授权", unknown: "未知" };
function PermissionRow({ name, label, state }: { name: string; label: string; state: ComputerPermissionState }): React.JSX.Element {
  return <div className="cu-permission" data-permission={name}><span>{label}</span><span className={`cu-permission-state is-${state}`}><span className="cu-sr-only">{permissionLabels[state]}</span><Icon name={state === "granted" ? "circle-check" : state === "denied" ? "close" : "help"} size={17} /></span></div>;
}
export function SettingsComputerUse(): React.JSX.Element {
  const [status, setStatus] = useState<ComputerStatus>();
  const [diagnostic, setDiagnostic] = useState<ComputerDiagnostics>();
  const [tested, setTested] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const api = window.binyComputer;
  const available = [api?.status, api?.enable, api?.control, api?.preview, api?.foreground, api?.logging, api?.diagnostics, api?.requestAccessibility, api?.testSetup].every(method => typeof method === "function");
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
  const diagnosticText = [
    diagnostic?.runtimeReady ? `✓ Cua Driver v${diagnostic.driverVersion} 运行时已创建` : diagnostic?.sdkLoaded ? `✓ SDK 已加载；要求 v${diagnostic.expectedVersion}，运行时尚未启用` : "✗ SDK 尚未加载",
    `辅助功能：${permissionLabels[permission?.accessibility ?? "unknown"]}`,
    `屏幕录制：${permissionLabels[permission?.screenRecording ?? "unknown"]}`,
    "配置测试只检查运行时、版本和权限，不截图、不输入。",
    diagnostic ? `宿主：${diagnostic.hostPath}` : "",
    diagnostic?.error ?? error ?? "",
    status?.diagnostic ?? ""
  ].filter(Boolean).join("\n");
  return <div className="settings-sections computer-use-settings">
    <section className="cu-card">
      <h3 className="cu-heading"><Icon name="cpu" size={17} />Computer Use</h3>
      <p className="cu-description">让 Biny 在后台操作受支持的 Mac 应用。需要辅助功能与屏幕录制权限。</p>
      <div className="cu-section"><h4>桌面控制组件</h4><div className="cu-helper" data-loaded={diagnostic?.sdkLoaded ?? false}>
        <Icon name={diagnostic?.sdkLoaded ? "circle-check" : "help"} size={17} />
        <strong>{!diagnostic ? "正在检查…" : diagnostic.sdkLoaded ? "已安装" : "组件不可用"}</strong><span>{diagnostic?.driverVersion ? `v${diagnostic.driverVersion}` : `要求 v${diagnostic?.expectedVersion ?? "0.30.4"}`}</span>
      </div></div>
      <div className="cu-section"><h4>权限</h4><div className="cu-permission-grid">
        <PermissionRow name="accessibility" label="辅助功能" state={permission?.accessibility ?? "unknown"} />
        <PermissionRow name="screenRecording" label="屏幕录制" state={permission?.screenRecording ?? "unknown"} />
      </div><div className="cu-button-row">
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(() => readDiagnostic(() => api.requestAccessibility()))}><Icon name="shield" size={14} />授权辅助功能</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { await readDiagnostic(); await updateStatus(() => api.status()); })}><Icon name="refresh" size={14} />刷新</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable} onClick={() => void perform(async () => { setTested(false); await readDiagnostic(() => api.testSetup()); await updateStatus(() => api.status()); if (mounted.current) setTested(true); })}><Icon name="eye" size={14} />测试我的配置</button>
      </div>
      {error || diagnostic?.error || status?.diagnostic ? <p className="cu-feedback" role="alert">{!available ? restartMessage : "桌面控制暂不可用，请查看诊断详情。"}</p> : tested ? <p className="cu-feedback" role="status">{diagnostic?.sdkLoaded && permission?.accessibility === "granted" && permission?.screenRecording === "granted" ? "配置检查通过" : "请完成组件安装与权限授权。"}</p> : null}
      </div>
      <div className="settings-row-group cu-toggles">
        <SettingsSwitch label="按应用严格审批" checked disabled detail="每次观察和操作都需批准。截图会发送给当前模型。" onChange={() => undefined} />
        <SettingsSwitch label="记录操作日志" checked={status?.actionLogging ?? false} disabled={unavailable || !status} detail="临时保留最近 50 条操作记录，停止后清空。" onChange={value => void perform(() => updateStatus(() => api.logging(value)))} />
        <SettingsSwitch label="画中画" checked={status?.preview ?? false} disabled={unavailable || !status} detail="在悬浮窗口查看操作画面；开启时暂停活动截图。" onChange={value => void perform(() => updateStatus(() => api.preview(value)))} />
      </div>
      <details className="cu-controls"><summary>控制与高级选项</summary><p role="status">{status ? `${stateLabels[status.state]} · ${outcomeLabels[status.lastOutcome]}` : "正在读取控制状态…"}</p><div className="cu-button-row">
        <button type="button" className="settings-secondary-button" disabled={unavailable || status?.state !== "disabled"} onClick={() => void perform(async () => { await updateStatus(() => api.enable()); await readDiagnostic(); })}><Icon name="power" size={14} />启用桌面控制</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || status?.state !== "ready"} onClick={() => control("pause")}><Icon name="pause" size={14} />暂停</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || !status || status.state === "ready" || status.state === "disabled"} onClick={() => control("resume")}><Icon name="play" size={14} />继续（需重新观察）</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || !status || status.state === "disabled"} onClick={() => control("takeover")}>人工接管</button>
        <button type="button" className="settings-secondary-button" disabled={unavailable || !status || status.state === "disabled"} onClick={() => control("stop")}><Icon name="stop" size={14} />停止</button>
      </div><p className="cu-muted">暂停或接管会撤销旧帧并取消排队操作。已派发的输入可能无法撤回；结果未知时先检查窗口，重新观察后继续，不自动重放。</p>
      <details><summary>前台操作与诊断日志</summary><label className="cu-foreground"><input type="checkbox" disabled={unavailable || !status} checked={status?.foregroundAllowed ?? false} onChange={event => void perform(() => updateStatus(() => api.foreground(event.target.checked)))} />允许明确批准的前台动作（可能改变焦点）</label>
        <p className="cu-muted">日志共 {diagnostic?.audit.length ?? 0} 条，点击“刷新”读取最新元数据。</p>
        {diagnostic?.audit.length ? <pre className="cu-diagnostics">{diagnostic.audit.map(entry => `${new Date(entry.at).toLocaleTimeString()} ${entry.action} PID ${entry.target.pid} / ${entry.target.windowId} ${outcomeLabels[entry.outcome]} ${entry.durationMs}ms`).join("\n")}</pre> : null}
      </details></details>
      <details className="cu-technical-details"><summary>诊断详情</summary>
        {diagnostic?.actionLimits?.map(limit => <p className="cu-description" data-action-limit={limit.action} key={limit.code}>{limit.message}</p>)}
        <pre className="cu-diagnostics">{diagnosticText}{diagnostic ? `\n组件：${diagnostic.workerPath}` : ""}</pre>
      </details>
    </section>
  </div>;
}
