/** 聊天设置的原生勾选行：整行关联标签，说明与状态由浏览器提供可访问语义。 */
import { useId } from "react";

export function SettingsCheckbox({ checked, disabled, label, detail, onChange }: {
  checked: boolean; disabled?: boolean; label: string; detail: string; onChange(value: boolean): void;
}): React.JSX.Element {
  const id = useId();
  return <label className="chat-settings-checkbox">
    <input aria-describedby={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>{label}</strong><small id={id}>{detail}</small></span>
  </label>;
}
