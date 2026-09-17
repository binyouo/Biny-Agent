/**
 * 设置内统一的布尔开关行：左侧标题与说明、右侧滑动开关。
 *
 * 开关几何与状态色按设计规范固定：轨道 1.5rem×2.75rem、圆头 1.25rem、
 * 选中位移 1.25rem；选中轨道用 --accent 蓝（状态指示，不跟随黑白操作主色），
 * 未选中为文字色的半透明灰。
 */
interface SettingsSwitchProps {
  checked: boolean;
  /** 说明文案可省略：开关含义已由 label 自明时不再重复解释。 */
  detail?: string;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}

export function SettingsSwitch({ checked, detail, disabled = false, label, onChange }: SettingsSwitchProps): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      className={`settings-switch-row${checked ? " is-checked" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="settings-switch-copy"><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
      <span aria-hidden="true" className="settings-switch"><span className="settings-switch-thumb" /></span>
    </button>
  );
}
