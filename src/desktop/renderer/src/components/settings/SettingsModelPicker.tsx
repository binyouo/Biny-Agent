/**
 * 设置页的模型选择器。
 *
 * 原生 select 在模型名相同、provider 较多时很难辨认；这里采用小型
 * grouped combobox 形态：触发器显示当前模型和 provider，展开后支持搜索、分组
 * 和 provider 图标。选项仍然是普通 button，避免引入一套新的菜单依赖。
 */
import { useEffect, useRef, useState } from "react";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { ProviderBrandIcon } from "../ProviderBrandIcon.js";
import type { SettingsModelPickerGroup } from "./settingsModelPickerData.js";

export function SettingsModelPicker({
  ariaLabel,
  disabled = false,
  groups,
  inheritLabel,
  onChange,
  placeholder,
  value
}: {
  ariaLabel: string;
  disabled?: boolean;
  groups: readonly SettingsModelPickerGroup[];
  inheritLabel?: string;
  onChange(value: string | undefined): void;
  placeholder: string;
  value?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  // 流动悬停：选项列表按选择器自动注册；未配置的禁用项对悬停不可见。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHoverItems(listRef, ".settings-model-picker-option");
  const selected = groups.flatMap((group) => group.options).find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => {
        if (!normalizedQuery) return true;
        return `${group.label} ${option.label} ${option.secondary ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
      })
    }))
    .filter((group) => group.options.length > 0);

  const choose = (next: string | undefined): void => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <details
      className={`settings-model-picker${disabled ? " is-disabled" : ""}`}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      open={open}
    >
      <summary
        aria-disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="settings-model-picker-trigger"
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        role="combobox"
      >
        {selected ? (
          <>
            <ProviderMark iconId={findGroup(groups, selected.value)?.iconId} iconTone={findGroup(groups, selected.value)?.iconTone ?? "compatible"} />
            <span className="settings-model-picker-trigger-copy">
              <strong>{selected.label}</strong>
            </span>
          </>
        ) : (
          <span className="settings-model-picker-placeholder">{placeholder}</span>
        )}
        <Icon className="settings-model-picker-chevron" name="chevron" size={15} />
      </summary>
      <div className="settings-model-picker-panel">
        <label className="settings-model-picker-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            aria-label="搜索模型或服务商"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型或服务商"
            type="search"
            value={query}
          />
        </label>
        <div className="settings-model-picker-options" ref={listRef} {...hover.handlers} role="listbox" aria-label={ariaLabel}>
          <FluidHoverHighlight hover={hover} className="has-row-radius" />
          {inheritLabel ? (
            <button
              aria-selected={value === undefined}
              className={`settings-model-picker-option is-inherit${value === undefined ? " is-selected" : ""}`}
              onClick={() => choose(undefined)}
              role="option"
              type="button"
            >
              <span className="settings-model-picker-option-check">{value === undefined ? <Icon name="check" size={13} /> : null}</span>
              <span className="settings-model-picker-option-copy"><strong>{inheritLabel}</strong></span>
            </button>
          ) : null}
          {visibleGroups.map((group) => (
            <section className="settings-model-picker-group" key={group.key}>
              <div className="settings-model-picker-group-heading">
                <ProviderMark iconId={group.iconId} iconTone={group.iconTone} />
                <strong>{group.label}</strong>
                <small>{group.options.length}</small>
              </div>
              {group.options.map((option) => {
                const selectedOption = option.value === value;
                return (
                  <button
                    aria-disabled={option.disabled}
                    aria-selected={selectedOption}
                    className={`settings-model-picker-option${selectedOption ? " is-selected" : ""}`}
                    disabled={option.disabled}
                    key={option.value}
                    onClick={() => choose(option.value)}
                    role="option"
                    type="button"
                  >
                    <span className="settings-model-picker-option-check">{selectedOption ? <Icon name="check" size={13} /> : null}</span>
                    <span className="settings-model-picker-option-copy">
                      <strong>{option.label}</strong>
                      {option.secondary ? <small>{option.secondary}{option.disabled ? " · 未配置" : ""}</small> : null}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
          {!visibleGroups.length ? <p className="settings-model-picker-empty">没有匹配的模型</p> : null}
        </div>
      </div>
    </details>
  );
}

function findGroup(groups: readonly SettingsModelPickerGroup[], value: string): SettingsModelPickerGroup | undefined {
  return groups.find((group) => group.options.some((option) => option.value === value));
}

function ProviderMark({ iconTone, iconId }: { iconTone: string; iconId?: string }): React.JSX.Element {
  return (
    <span className={`settings-model-picker-provider-mark${iconTone === "local" ? " is-local" : ""}`}>
      {iconTone === "local"
        ? <Icon name="database" size={14} />
        : <ProviderBrandIcon className="provider-logo" fallback={<ProviderBrandGlyph type={iconTone} />} iconId={iconId} />}
    </span>
  );
}
