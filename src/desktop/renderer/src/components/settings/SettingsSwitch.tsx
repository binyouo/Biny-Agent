import React, { useId } from "react";

interface SettingsSwitchProps {
  checked: boolean;
  /** 说明文案可省略：开关含义已由 label 自明时不再重复解释。 */
  detail?: string;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}

export function SettingsSwitch({ checked, detail, disabled = false, label, onChange }: SettingsSwitchProps): React.JSX.Element {
  const descriptionId = useId();
  return (
    <div className="settings-switch-row">
      <span className="settings-switch-copy"><strong>{label}</strong>{detail ? <small id={descriptionId}>{detail}</small> : null}</span>
      <input
        aria-checked={checked}
        aria-describedby={detail ? descriptionId : undefined}
        aria-label={label}
        checked={checked}
        className="settings-switch"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
    </div>
  );
}
