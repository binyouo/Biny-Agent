/**
 * 设置内统一的布尔开关行：左侧标题与说明、右侧滑动开关。
 *
 * 开启态与主要操作共用黑白配色，未开启时使用中性灰轨道。
 */
import React from "react";

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
      aria-label={label}
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
