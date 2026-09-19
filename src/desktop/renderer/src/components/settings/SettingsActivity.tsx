/** 活动记录设置：采集配置、运行摘要与权限入口；截图仅在后台使用。 */
import { useEffect, useRef, useState } from "react";
import type { ActivityRuntimeSnapshot } from "../../../../../activity/types.js";
import type { DesktopActivitySettingsInput } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { useActivityRuntime } from "./ActivityRuntimeContext.js";

export function SettingsActivity(): React.JSX.Element {
  const { activity, loadError, updateActivityImmediately } = useSettingsDraft();
  const { runtime, refresh, updateRuntime } = useActivityRuntime();
  if (!activity) return <div aria-busy={!loadError} className="settings-sections"><section><p role={loadError ? "alert" : "status"}>{loadError ? `活动记录设置加载失败：${loadError}。请关闭设置后重试。` : "正在加载活动记录设置…"}</p></section></div>;
  return <SettingsActivityForm activity={activity} onChange={updateActivityImmediately} onRefreshRuntime={refresh} onRuntimeChange={updateRuntime} runtime={runtime} />;
}

function SettingsActivityForm({ activity, onChange, onRefreshRuntime, onRuntimeChange, runtime }: { activity: DesktopActivitySettingsInput; onChange(patch: Partial<DesktopActivitySettingsInput>): Promise<void>; onRefreshRuntime(): Promise<ActivityRuntimeSnapshot>; onRuntimeChange(next: ActivityRuntimeSnapshot): void; runtime: ActivityRuntimeSnapshot | undefined }): React.JSX.Element {
  const [languagesText, setLanguagesText] = useState(activity.ocrLanguages.join(", "));
  const [sensitiveApplicationsText, setSensitiveApplicationsText] = useState(activity.sensitiveApplications.join("\n"));
  const [clearing, setClearing] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [requestingPermission, setRequestingPermission] = useState<"screen-recording" | "accessibility">();
  const [activityUpdateCount, setActivityUpdateCount] = useState(0);
  const languagesInputRef = useRef<HTMLInputElement>(null);
  const sensitiveApplicationsInputRef = useRef<HTMLTextAreaElement>(null);
  const activityFocusRestoreRef = useRef<{ id?: string; ariaLabel?: string } | undefined>(undefined);
  const updateActivity = (patch: Partial<DesktopActivitySettingsInput>): void => {
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : undefined;
    if (activeElement) {
      activityFocusRestoreRef.current = {
        id: activeElement.id || undefined,
        ariaLabel: activeElement.getAttribute("aria-label") ?? undefined
      };
    }
    setActivityUpdateCount((count) => count + 1);
    setFeedback(undefined);
    void onChange(patch).catch((error: unknown) => {
      setFeedback(activityErrorMessage(error));
    }).finally(() => {
      setActivityUpdateCount((count) => Math.max(0, count - 1));
    });
  };

  useEffect(() => {
    if (activityUpdateCount !== 0) return;
    const target = activityFocusRestoreRef.current;
    activityFocusRestoreRef.current = undefined;
    if (!target || document.activeElement !== document.body) return;
    const candidate = target.id
      ? document.getElementById(target.id)
      : target.ariaLabel
        ? [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((element) => {
          const rect = element.getBoundingClientRect();
          return element.getAttribute("aria-label") === target.ariaLabel && rect.width > 0 && rect.height > 0;
        })
        : undefined;
    candidate?.focus();
  }, [activityUpdateCount]);

  useEffect(() => {
    if (document.activeElement !== languagesInputRef.current) setLanguagesText(activity.ocrLanguages.join(", "));
    if (document.activeElement !== sensitiveApplicationsInputRef.current) setSensitiveApplicationsText(activity.sensitiveApplications.join("\n"));
  }, [activity.ocrLanguages, activity.sensitiveApplications]);

  const refreshRuntime = (): void => {
    void onRefreshRuntime().catch((error: unknown) => setFeedback(activityErrorMessage(error)));
  };

  const commitLanguages = (): void => {
    const languages = languagesText.split(",").map((value) => value.trim()).filter(Boolean);
    if (languages.length === 0 || languages.some((value) => value.length < 2 || value.length > 32)) {
      setLanguagesText(activity.ocrLanguages.join(", "));
      return;
    }
    setLanguagesText(languages.join(", "));
  };
  const updateLanguages = (value: string): void => {
    setLanguagesText(value);
    const languages = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (languages.length > 0 && languages.every((item) => item.length >= 2 && item.length <= 32)) {
      updateActivity({ ocrLanguages: languages });
    }
  };
  const updateSensitiveApplications = (value: string): void => {
    setSensitiveApplicationsText(value);
    updateActivity({ sensitiveApplications: value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) });
  };
  const openPermissionSettings = async (pane: "screen-recording" | "accessibility"): Promise<void> => {
    if (requestingPermission !== undefined) return;
    setRequestingPermission(pane);
    setFeedback(undefined);
    let failureMessage: string | undefined;
    try {
      await window.biny.requestActivityPermission(pane);
    } catch (error) {
      failureMessage = activityErrorMessage(error);
    }
    try {
      await window.biny.openSystemSettings(pane);
    } catch (error) {
      failureMessage = activityErrorMessage(error);
    }
    if (failureMessage) setFeedback(failureMessage);
    setRequestingPermission(undefined);
  };
  const openAccessibilitySettings = (): void => { void openPermissionSettings("accessibility"); };
  const openScreenRecordingSettings = (): void => { void openPermissionSettings("screen-recording"); };
  const clearActivity = (): void => {
    if (clearing) return;
    setClearOpen(true);
  };
  const confirmClearActivity = (): void => {
    if (clearing) return;
    setClearing(true);
    void window.biny.clearActivity().then((next) => {
      onRuntimeChange(next);
      setClearOpen(false);
      setFeedback("已清除全部 Activity 数据。");
    }).catch((error: unknown) => setFeedback(activityErrorMessage(error))).finally(() => setClearing(false));
  };
  const storagePercent = runtime === undefined || activity.maxStorageMb <= 0
    ? 0
    : Math.min(100, (runtime.storageBytes / (activity.maxStorageMb * 1024 * 1024)) * 100);
  const runtimeLabel = activity.enabled ? activityServiceLabel(runtime) : "已暂停";
  const isRuntimeRunning = activity.enabled && runtime?.state === "running";
  const isRecording = isRuntimeRunning && runtime?.screenLocked === false;
  const runtimeStorage = runtime === undefined
    ? "采集服务未接入"
    : `${formatActivityBytes(runtime.storageBytes)} / ${formatActivityBytes(activity.maxStorageMb * 1024 * 1024)}（${Math.round(storagePercent)}%）`;
  const permissionStatus = (granted: boolean | undefined, enabled = true): string => {
    if (!enabled) return "未启用";
    if (granted === undefined) return "检查中";
    return granted ? "已授权" : "需授权";
  };
  const screenPermission = permissionStatus(runtime?.screenRecordingGranted);
  const accessibilityPermission = permissionStatus(runtime?.accessibilityGranted);
  const activityUpdating = activityUpdateCount > 0;
  const activityStatusClass = runtime?.state === "error"
    ? " is-error"
    : runtime?.state === "permission_required" || runtime?.state === "unavailable"
      ? " is-warning"
      : isRecording
        ? " is-recording"
        : activity.enabled
          ? " is-enabled"
          : "";
  return (
      <div className="settings-sections activity-settings">
      <section aria-busy={activityUpdating} className="activity-card activity-overview" id="activity-overview" tabIndex={-1}>
        <div className="activity-overview-heading">
          <div className="activity-heading-copy">
            <div className="activity-title-line">
              <Icon name="activity" size={15} />
              <h3>活动记录器</h3>
              <span className={`activity-status-badge${activityStatusClass}`}>
                {runtimeLabel}
              </span>
              {isRuntimeRunning && runtime?.screenLocked ? <span className="activity-status-badge is-locked"><Icon name="lock" size={11} />已锁屏</span> : null}
            </div>
            <p>以周期截屏和本地 OCR 生成时间线，原始截图始终留在本机。</p>
          </div>
          <ActivitySwitch busy={activityUpdating} checked={activity.enabled} disabled={activityUpdating} label="启用活动记录器" onChange={(enabled) => updateActivity({ enabled })} />
        </div>
        {/* 总开关关闭时状态区不隐藏，整体变暗保留上下文。 */}
        <div className={`activity-overview-stats${activity.enabled ? "" : " is-disabled"}`}>
          <div className="activity-stat-grid">
            <ActivityStat icon="timer" label="会话数" value={runtime === undefined ? "—" : String(runtime.sessions)} />
            <ActivityStat icon="database" label="截图存储" value={runtime === undefined ? "—" : formatActivityBytes(runtime.storageBytes)} />
            <ActivityStat icon="activity" label="当前会话" value={runtime === undefined ? "—" : runtime.screenLocked ? "已锁屏" : runtime.currentSessionId ? "活跃" : "空闲"} />
            <ActivityStat icon="display" label="前台应用" value={runtime?.currentApplication ?? "—"} />
          </div>
          <div className="activity-storage-summary">
            <div><span>已用存储</span><strong>{runtimeStorage}</strong></div>
            <span className="activity-storage-hint">超过上限时自动清理旧截图</span>
          </div>
          <div aria-hidden="true" className="activity-progress"><span style={{ width: `${storagePercent}%` }} /></div>
        </div>
        {runtime?.error ? <p className="activity-section-description is-error" role="alert">{runtime.error}</p> : null}
        {feedback ? <p aria-live="polite" className="activity-feedback" role="status">{feedback}</p> : null}
      </section>

      <ActivitySection
        action={<button aria-label="刷新 macOS 权限状态" className="activity-icon-button" onClick={refreshRuntime} title="刷新权限状态" type="button"><Icon name="refresh" size={14} /></button>}
        id="activity-permissions"
        icon="shield"
        title="macOS 权限"
      >
        <div className="activity-permission-list">
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 屏幕录制" label="屏幕录制" status={screenPermission} />
            {screenPermission === "需授权" ? (
              <button aria-busy={requestingPermission === "screen-recording"} aria-label="申请并在 macOS 系统设置中管理屏幕录制权限" className="activity-secondary-button" disabled={requestingPermission !== undefined} onClick={openScreenRecordingSettings} type="button">
                <Icon name="external" size={13} />
                {requestingPermission === "screen-recording" ? "申请中…" : "申请并打开设置"}
              </button>
            ) : null}
          </div>
          <div className="activity-permission-row">
            <ActivityPermission detail="隐私与安全性 → 辅助功能" label="辅助功能" status={accessibilityPermission} />
            {accessibilityPermission === "需授权" ? (
              <button aria-busy={requestingPermission === "accessibility"} aria-label="申请并在 macOS 系统设置中管理辅助功能权限" className="activity-secondary-button" disabled={requestingPermission !== undefined} onClick={openAccessibilitySettings} type="button">
                <Icon name="external" size={13} />
                {requestingPermission === "accessibility" ? "申请中…" : "申请并打开设置"}
              </button>
            ) : null}
          </div>
          {runtime?.screenRecordingGranted === false && runtime?.collectorAvailable === true
            ? <p className="activity-section-description">输入事件仍可记录，但截图与 OCR 暂不可用。</p>
            : null}
        </div>
      </ActivitySection>

      <ActivitySection id="activity-capture" icon="activity" title="采集">
        <div className="activity-field-grid">
          <ActivityNumberField disabled={!activity.enabled} id="activity-debounce" label="截图防抖" hint="范围：3000–30000" unit="ms" max={30_000} min={3_000} step={100} value={activity.captureDebounceMs} onCommit={(value) => updateActivity({ captureDebounceMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-heartbeat" label="心跳间隔" hint="画面不变时仍按此间隔保留时间锚点" unit="ms" max={300_000} min={60_000} step={1_000} value={activity.heartbeatMs} onCommit={(value) => updateActivity({ heartbeatMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-idle" label="空闲阈值" hint="无事件达到该时长后关闭当前会话" unit="ms" max={600_000} min={10_000} step={5_000} value={activity.idleTimeoutMs} onCommit={(value) => updateActivity({ idleTimeoutMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-input-pause" label="输入停顿" hint="无输入 N 毫秒后检查是否需要截图" unit="ms" max={5_000} min={800} step={100} value={activity.inputPauseMs} onCommit={(value) => updateActivity({ inputPauseMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-visual-poll" label="截图轮询" hint="定期检查画面并触发截图；0 = 关闭" unit="ms" max={30_000} min={0} step={500} value={activity.visualPollMs} onCommit={(value) => updateActivity({ visualPollMs: value })} />
          <ActivityNumberField disabled={!activity.enabled} id="activity-jpeg-quality" label="JPEG 质量" hint="30–95，越低文件越小" unit="" max={95} min={30} step={5} value={activity.jpegQuality} onCommit={(value) => updateActivity({ jpegQuality: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-ocr" icon="file" title="OCR 与输入">
        <div className="activity-toggle-list">
          <ActivitySwitch checked={activity.ocrEnabled} detail="对活动截图运行本地 Vision 识别。" disabled={!activity.enabled} label="对活动截图运行 Vision OCR" onChange={(ocrEnabled) => updateActivity({ ocrEnabled })} />
          <ActivitySwitch checked={activity.inputMonitoringEnabled} detail="记录点击和键盘活动类型，不记录键值。" disabled={!activity.enabled} label="全局键盘与鼠标监听" onChange={(inputMonitoringEnabled) => updateActivity({ inputMonitoringEnabled })} />
        </div>
        <div className="activity-field-grid activity-ocr-fields">
          <label className="activity-field activity-field-wide" htmlFor="activity-ocr-languages">
            <span>OCR 语言（Vision 代码，逗号分隔）</span>
            <input aria-describedby="activity-ocr-languages-hint" autoComplete="off" disabled={!activity.enabled} id="activity-ocr-languages" name="activity-ocr-languages" onBlur={commitLanguages} onChange={(event) => updateLanguages(event.target.value)} ref={languagesInputRef} spellCheck={false} value={languagesText} />
            <small id="activity-ocr-languages-hint">例如 en-US, zh-Hans。</small>
          </label>
          <ActivityNumberField disabled={!activity.enabled} id="activity-ocr-every" label="每 N 张快照 OCR 一次" unit="" max={20} min={1} step={1} value={activity.ocrEveryNFrames} onCommit={(value) => updateActivity({ ocrEveryNFrames: value })} />
        </div>
      </ActivitySection>

      <ActivitySection id="activity-sensitive-apps" icon="shield" title="敏感应用（不保存文本/截图）">
        <p className="activity-section-description">每行一个 bundle ID；命中的应用不保存文本、OCR 和截图。</p>
        <textarea aria-label="敏感应用 bundle ID" autoComplete="off" className="activity-sensitive-apps" disabled={!activity.enabled} name="activity-sensitive-applications" onChange={(event) => updateSensitiveApplications(event.target.value)} ref={sensitiveApplicationsInputRef} rows={4} spellCheck={false} value={sensitiveApplicationsText} />
      </ActivitySection>

      <ActivitySection id="activity-storage" icon="database" title="存储配额">
        <div className="activity-field-grid">
          <ActivityNumberField disabled={!activity.enabled} id="activity-max-storage" label="最大存储（MB）" hint="只限制截图 JPEG；10240 = 10 GB。" unit="" max={200_000} min={100} step={100} value={activity.maxStorageMb} onCommit={(value) => updateActivity({ maxStorageMb: value })} />
          <label className="activity-field" htmlFor="activity-output-directory">
            <span>输出目录</span>
            <input aria-describedby="activity-output-directory-hint" autoComplete="off" id="activity-output-directory" name="activity-output-directory" readOnly spellCheck={false} value={activity.outputDirectory} />
            <small id="activity-output-directory-hint">全局目录，不写入当前项目。</small>
          </label>
        </div>
        <p className="activity-storage-note">事件和脱敏摘要不受容量上限影响。</p>
      </ActivitySection>

      {activity.enabled && runtime !== undefined && runtime.recentSessions.length > 0 ? (
        <ActivitySection
          action={<button aria-label="刷新最近会话" className="activity-icon-button" onClick={refreshRuntime} title="刷新最近会话" type="button"><Icon name="refresh" size={14} /></button>}
          id="activity-recent-sessions"
          icon="timer"
          title="最近会话"
        >
          <div className="activity-session-list">
            {runtime.recentSessions.slice(0, 8).map((session) => (
              <div className="activity-session-row" key={session.id}>
                <div className="activity-session-title">{session.analysisTitle || session.applications.join(", ") || "会话"}</div>
                <div className="activity-session-meta">
                  {formatActivityRelative(session.startedAt)} · {session.endedAt ? formatActivityDuration(session.startedAt, session.endedAt) : "活跃"} · {session.snapshotCount} 张快照 · {session.eventCount} 个事件
                </div>
                {session.analysisDescription ? <div className="activity-session-description">{session.analysisDescription}</div> : null}
              </div>
            ))}
          </div>
        </ActivitySection>
      ) : null}

      <section className="activity-card activity-danger-zone" id="activity-danger" tabIndex={-1}>
        <div className="activity-section-title is-danger"><Icon name="trash" size={15} /><h3>危险区</h3></div>
        <p className="activity-section-description">删除活动会话、事件、OCR、截图、分析和摘要。不可撤销；已沉淀的长期记忆、结晶和已导出日报保留，需在各自位置单独删除。</p>
        <button className="activity-danger-button" disabled={clearing || runtime?.sessions === 0 || runtime === undefined} onClick={clearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "清除全部活动数据"}</button>
        <small className="activity-disabled-hint">{runtime?.sessions ? undefined : runtime?.collectorAvailable === false ? "采集服务尚未接入，清除操作暂不可用。" : "暂无可清除的活动数据。"}</small>
      </section>

      {isRuntimeRunning ? <p className="activity-running-footer">运行中 · 多数参数即时生效；会话与空闲计时相关改动在下一个会话生效。</p> : null}

      {clearOpen ? (
        <SettingsDetailLayer onClose={() => { if (!clearing) setClearOpen(false); }}>
          <section aria-describedby="activity-clear-description" aria-labelledby="activity-clear-title" aria-modal="true" className="settings-confirm-panel activity-clear-panel" role="dialog">
            <h3 id="activity-clear-title">清除全部 Activity 数据？</h3>
            <p id="activity-clear-description">将永久删除 {runtime?.sessions ?? 0} 个会话、{runtime?.events ?? 0} 个事件，以及截图、OCR、分析和摘要。此操作不可撤销。已沉淀的长期记忆、结晶和已导出日报不会删除。</p>
            <div className="settings-confirm-actions"><button className="ghost-button" disabled={clearing} onClick={() => setClearOpen(false)} type="button">取消</button><button className="ghost-button is-danger" disabled={clearing} onClick={confirmClearActivity} type="button"><Icon name="trash" size={14} />{clearing ? "清除中…" : "永久清除"}</button></div>
          </section>
        </SettingsDetailLayer>
      ) : null}
    </div>
  );
}

function activityServiceLabel(runtime: ActivityRuntimeSnapshot | undefined): string {
  if (!runtime) return "正在连接";
  if (runtime.screenLocked) return "已锁屏，暂停截图";
  if (runtime.state === "running") return "录制中";
  if (runtime.state === "permission_required") return "等待权限";
  if (runtime.state === "error") return "采集错误";
  if (runtime.state === "unavailable") return "不可用";
  if (runtime.state === "paused") return "已暂停";
  return "未连接";
}

function formatActivityBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024 * 1024) >= 1 ? value / (1024 * 1024 * 1024) : value / (1024 * 1024)).toFixed(2)} ${value / (1024 * 1024 * 1024) >= 1 ? "GB" : "MB"}`;
}

/** 最近会话的开始时间用相对时间表达；粒度与 alma 对齐：刚刚/分钟/小时/天。 */
function formatActivityRelative(iso: string): string {
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffMinutes < 60 * 24) return `${Math.floor(diffMinutes / 60)} 小时前`;
  return `${Math.floor(diffMinutes / (60 * 24))} 天前`;
}

function formatActivityDuration(startedAt: string, endedAt: string): string {
  const minutes = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function activityErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Activity 操作失败，请稍后重试。";
}

function ActivitySection({ action, children, icon, id, title }: { action?: React.ReactNode; children: React.ReactNode; icon: IconName; id: string; title: string }): React.JSX.Element {
  return (
    <section className="activity-card" id={id} tabIndex={-1}>
      <div className="activity-section-heading">
        <div className="activity-section-title"><Icon name={icon} size={15} /><h3>{title}</h3></div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActivityStat({ icon, label, value }: { icon: IconName; label: string; value: string }): React.JSX.Element {
  return (
    <div className="activity-stat">
      <span className="activity-stat-label"><Icon name={icon} size={12} />{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivityPermission({ detail, label, status }: { detail: string; label: string; status: string }): React.JSX.Element {
  const stateClass = status === "已授权" ? "is-granted" : status === "需授权" ? "is-needed" : status === "未启用" ? "is-disabled" : "";
  /* 状态图标做成圆形徽章：已授权显示对勾，需授权显示警告，其余为中性盾牌。 */
  const stateIcon: IconName = status === "已授权" ? "check" : status === "需授权" ? "warning" : "shield";
  return (
    <div className={`activity-permission-copy ${stateClass}`}>
      <span className="activity-permission-state"><Icon name={stateIcon} size={11} /></span>
      <span className="activity-permission-text">
        <strong>{label}<em>{status}</em></strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}

function ActivitySwitch({ busy = false, checked, detail, disabled = false, label, onChange }: { busy?: boolean; checked: boolean; detail?: string; disabled?: boolean; label: string; onChange(value: boolean): void }): React.JSX.Element {
  return (
    <button aria-busy={busy} aria-checked={checked} aria-label={label} className={`activity-switch${checked ? " is-checked" : ""}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button">
      {detail ? <span className="activity-switch-copy"><strong>{label}</strong><small>{detail}</small></span> : null}
      <span aria-hidden="true" className="activity-switch-track"><span /></span>
    </button>
  );
}

function ActivityNumberField({ disabled = false, hint, id, label, max, min, onCommit, step = 1, unit, value }: { disabled?: boolean; hint?: string; id: string; label: string; max: number; min: number; onCommit(value: number): void; step?: number; unit: string; value: number }): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSentValueRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (value === lastSentValueRef.current) lastSentValueRef.current = undefined;
    if (document.activeElement !== inputRef.current) setText(String(value));
  }, [value]);
  const clamp = (raw: string): number | undefined => {
    if (raw.trim() === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  };
  const send = (next: number): void => {
    if (next === value || next === lastSentValueRef.current) return;
    lastSentValueRef.current = next;
    onCommit(next);
  };
  const handleChange = (raw: string): void => {
    setText(raw);
    const next = clamp(raw);
    if (next !== undefined) send(next);
  };
  const commit = (): void => {
    const next = clamp(text);
    if (next === undefined) {
      setText(String(value));
      return;
    }
    setText(String(next));
    send(next);
  };
  return (
    <label className="activity-field" htmlFor={id}>
      <span>{label}</span>
      <div className="activity-number-input"><input aria-describedby={hint ? `${id}-hint` : undefined} autoComplete="off" disabled={disabled} id={id} inputMode="numeric" max={max} min={min} name={id} onBlur={commit} onChange={(event) => handleChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} ref={inputRef} step={step} type="number" value={text} />{unit ? <em>{unit}</em> : null}</div>
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </label>
  );
}
