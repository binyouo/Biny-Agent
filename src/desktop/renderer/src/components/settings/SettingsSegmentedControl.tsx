import { useId } from "react";

/** 原生单选保留方向键与焦点语义，外层只负责分段样式。 */
export function SettingsSegmentedControl<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  onChange(value: T): void;
}): React.JSX.Element {
  const name = useId();
  return <div aria-label={label} className="settings-segmented" role="radiogroup">
    {options.map((option) => <label key={option.value}>
      <input checked={value === option.value} disabled={disabled} name={name} onChange={() => onChange(option.value)} type="radio" value={option.value} />
      <span>{option.label}</span>
    </label>)}
  </div>;
}
