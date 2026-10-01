/** 设置中心固定底栏：统一展示草稿状态并提交整个设置事务。 */
import type { SettingsSaveState } from "./SettingsDraftContext.js";

export function SettingsPageFooter({
  dirtyCount,
  hint,
  disabled,
  unavailable,
  blockedReason,
  error,
  onCancel,
  onSave,
  state
}: {
  dirtyCount: number;
  hint?: string;
  disabled: boolean;
  unavailable?: string;
  blockedReason?: string;
  error?: string;
  onCancel(): void;
  onSave(): void;
  state: SettingsSaveState;
}): React.JSX.Element {
  const status = unavailable ?? settingsSaveStatus(state, dirtyCount);
  const clean = dirtyCount === 0 && state === "clean";
  return (
    <footer className="settings-page-footer">
      <div className="settings-save-feedback">
        {error ? <p className="settings-save-error" role="alert">{error}</p> : null}
        <p aria-live="polite" className={`settings-save-status is-${state}`} id="settings-save-status" role="status">{status}{blockedReason ? <span>{blockedReason}</span> : null}</p>
        {hint ? <small className="settings-save-scope">{hint}</small> : null}
      </div>
      <span className="settings-footer-actions">
        <button className="ghost-button" disabled={state === "saving" || state === "rolling_back"} onClick={onCancel} type="button">{clean ? "关闭" : "取消"}</button>
        <button
          aria-describedby="settings-save-status"
          className="settings-save-button"
          disabled={disabled || dirtyCount === 0 || state === "invalid" || state === "saving" || state === "rolling_back" || state === "recovery_required"}
          onClick={onSave}
          type="button"
        >
          {state === "saving" ? "保存中…" : state === "rolling_back" ? "回滚中…" : error ? "重试保存" : "保存"}
        </button>
      </span>
    </footer>
  );
}

function settingsSaveStatus(state: SettingsSaveState, dirtyCount: number): string {
  if (state === "invalid") return "请检查填写的数值范围";
  if (state === "saving") return "保存中…";
  if (state === "rolling_back") return "回滚中…";
  if (state === "recovery_required") return "需要恢复设置后才能继续";
  if (state === "dirty" || dirtyCount > 0) return `${dirtyCount} 组未保存更改`;
  return "所有更改已保存";
}
