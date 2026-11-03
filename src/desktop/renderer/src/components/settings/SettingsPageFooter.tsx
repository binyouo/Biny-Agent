/** 底栏只展示手动提交的草稿状态；即时操作在所属设置项反馈。 */
import type { SettingsSaveState } from "./SettingsDraftContext.js";

export function SettingsPageFooter({
  dirtyCount,
  disabled,
  unavailable,
  blockedReason,
  error,
  onCancel,
  onSave,
  state
}: {
  dirtyCount: number;
  disabled: boolean;
  unavailable?: string;
  blockedReason?: string;
  error?: string;
  onCancel(): void;
  onSave(): void;
  state: SettingsSaveState;
}): React.JSX.Element {
  const saving = state === "saving" || state === "rolling_back";
  const status = unavailable ?? settingsSaveStatus(state, dirtyCount);
  return (
    <footer className="settings-page-footer">
      <div className="settings-save-feedback">
        {error ? <p className="settings-save-error" role="alert">{error}</p> : null}
        <p aria-live="polite" className="settings-save-status" id="settings-save-status" role="status">{status}{blockedReason ? <span>{blockedReason}</span> : null}</p>
      </div>
      <span className="settings-footer-actions">
        <button className="settings-action settings-secondary-button" disabled={saving} onClick={onCancel} type="button">关闭</button>
        <button
          aria-busy={saving}
          aria-describedby="settings-save-status"
          className="settings-action settings-primary-button settings-save-button"
          disabled={disabled || dirtyCount === 0 || state === "invalid" || saving || state === "recovery_required"}
          onClick={onSave}
          type="button"
        >
          保存
        </button>
      </span>
    </footer>
  );
}

function settingsSaveStatus(state: SettingsSaveState, dirtyCount: number): string {
  if (state === "invalid") return "请检查填写的数值范围";
  if (state === "saving" || state === "rolling_back") return "保存中…";
  if (state === "recovery_required") return "需要恢复设置后才能继续";
  if (state === "dirty" || dirtyCount > 0) return "有未保存更改";
  return "无待保存更改";
}
