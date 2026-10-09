/**
 * 设置页的模型选择器。
 *
 * 原生 select 在模型名相同、provider 较多时很难辨认；这里采用小型
 * grouped combobox 形态：触发器显示当前模型和 provider，展开后支持搜索、分组
 * 和 provider 图标。选项仍然是普通 button，避免引入一套新的菜单依赖。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { ProviderBrandIcon } from "../ProviderBrandIcon.js";
import type { SettingsModelPickerGroup } from "./settingsModelPickerData.js";

export function SettingsModelPicker({
  ariaLabel,
  compact = false,
  disabled = false,
  groups,
  inheritLabel,
  onChange,
  placeholder,
  selectionHint,
  value
}: {
  ariaLabel: string;
  compact?: boolean;
  disabled?: boolean;
  groups: readonly SettingsModelPickerGroup[];
  inheritLabel?: string;
  onChange(value: string | undefined): void;
  placeholder: string;
  selectionHint?: string;
  value?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || !(event.target instanceof Node) || !detailsRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus({ preventScroll: true });
    };
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target)) { setOpen(false); setQuery(""); }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);
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
        return `${group.label} ${option.label} ${option.secondary ?? ""} ${option.trailing ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
      })
    }))
    .filter((group) => group.options.length > 0);

  const choose = (next: string | undefined): void => {
    onChange(next);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <details
      className={`settings-model-picker${compact ? " is-compact" : ""}${disabled ? " is-disabled" : ""}`}
      ref={detailsRef}
      onKeyDown={event => {
        if (disabled || event.nativeEvent.isComposing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!open) { setOpen(true); return; }
        const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? (current + 1) % options.length : current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
        options[next]?.focus();
      }}
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
        aria-controls={listId}
        aria-label={ariaLabel}
        className="settings-model-picker-trigger"
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        role="combobox"
        ref={triggerRef}
      >
        {selected ? (
          <>
            <ProviderMark iconId={findGroup(groups, selected.value)?.iconId} iconTone={findGroup(groups, selected.value)?.iconTone ?? "compatible"} />
            <span className="settings-model-picker-trigger-copy">
              <strong>{selected.label}</strong>
              {selectionHint ? <small>（{selectionHint}）</small> : null}
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
        <div className="settings-model-picker-options" id={listId} ref={listRef} {...hover.handlers} role="listbox" aria-label={ariaLabel}>
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
                {!compact ? <small>{group.options.length}</small> : null}
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
                    {option.trailing ? <small className="settings-model-picker-option-trailing">{option.trailing}</small> : null}
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
