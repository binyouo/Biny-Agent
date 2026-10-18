import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  resolvedValue,
  selectionHint,
  value
}: {
  ariaLabel: string;
  disabled?: boolean;
  groups: readonly SettingsModelPickerGroup[];
  inheritLabel?: string;
  onChange(value: string | undefined): void;
  placeholder: string;
  resolvedValue?: string;
  selectionHint?: string;
  value?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const expanded = open && !disabled;
  const effectiveValue = value ?? resolvedValue;
  const selectedGroup = groups.find(group => group.options.some(option => option.value === effectiveValue));
  const selected = selectedGroup?.options.find(option => option.value === effectiveValue);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.map(group => ({
    ...group,
    options: group.options.filter(option => !normalizedQuery
      || `${group.label} ${option.label} ${option.secondary ?? ""} ${option.trailing ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
  })).filter(group => group.options.length > 0);

  const close = (): void => { setOpen(false); setQuery(""); };
  const choose = (next: string | undefined): void => {
    onChange(next);
    close();
    triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    // 保留设置主题与详情层焦点边界，同时脱离页面滚动区的裁切。
    setPortalTarget(pickerRef.current?.closest<HTMLElement>(".settings-detail-layer, .settings-modal, dialog") ?? document.body);
  }, []);

  useLayoutEffect(() => {
    if (!expanded) return;
    const anchor = triggerRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    let active = true;
    let focused = false;
    const update = (): void => {
      void computePosition(anchor, panel, {
        strategy: "fixed", placement: "bottom-start",
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), size({
          padding: 8,
          apply({ availableHeight, rects, elements }) {
            if (!active) return;
            Object.assign(elements.floating.style, {
              width: `${Math.min(rects.reference.width, Math.max(0, window.innerWidth - 16))}px`,
              maxHeight: `${Math.max(0, availableHeight)}px`
            });
          }
        })]
      }).then(({ x, y }) => {
        if (!active) return;
        Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
        if (!focused) { searchRef.current?.focus({ preventScroll: true }); focused = true; }
      });
    };
    const cleanup = autoUpdate(anchor, panel, update);
    return () => { active = false; cleanup(); };
  }, [expanded, portalTarget]);

  useEffect(() => {
    if (!expanded) return;
    const contains = (target: EventTarget | null): boolean => target instanceof Node
      && Boolean(pickerRef.current?.contains(target) || panelRef.current?.contains(target));
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || !contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus({ preventScroll: true });
    };
    const closeOutside = (event: PointerEvent): void => {
      if (!contains(event.target)) { setOpen(false); setQuery(""); }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("pointerdown", closeOutside);
    };
  }, [expanded]);

  return (
    <div
      className={`settings-model-picker${expanded ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}
      ref={pickerRef}
      onKeyDown={event => {
        if (disabled || event.nativeEvent.isComposing) return;
        const searching = event.target === searchRef.current;
        const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
        if (expanded && searching && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const candidate = normalizedQuery ? options.find(option => !option.classList.contains("is-inherit"))
            : options.find(option => option.getAttribute("aria-selected") === "true") ?? options[0];
          candidate?.click();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (searching && ["Home", "End"].includes(event.key))) return;
        event.preventDefault();
        event.stopPropagation();
        if (!expanded) { setOpen(true); return; }
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : event.key === "ArrowDown" ? (current + 1) % options.length : current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
        options[next]?.focus();
        options[next]?.scrollIntoView?.({ block: "nearest" });
      }}
      onBlur={event => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || (!pickerRef.current?.contains(next) && !panelRef.current?.contains(next))) close();
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-controls={expanded ? listId : undefined}
        aria-label={ariaLabel}
        className="settings-model-picker-trigger"
        onClick={event => {
          event.preventDefault();
          if (!disabled) { setOpen(!expanded); setQuery(""); }
        }}
        role="combobox"
        ref={triggerRef}
        title={selected ? `${selectedGroup?.label} · ${selected.label}` : value ?? placeholder}
      >
        {selected ? (
          <>
            <ProviderMark iconId={selectedGroup?.iconId} iconTone={selectedGroup?.iconTone ?? "compatible"} />
            <span className="settings-model-picker-trigger-copy">
              <strong>{selected.label}</strong>
              {selectionHint ? <small>（{selectionHint}）</small> : null}
            </span>
          </>
        ) : <span className="settings-model-picker-placeholder">{value ?? placeholder}</span>}
        <Icon className="settings-model-picker-chevron" name="chevron" size={15} />
      </button>
      {expanded && portalTarget ? createPortal(
        <div className="settings-model-picker-panel" ref={panelRef} style={{ visibility: "hidden" }}>
          <label className="settings-model-picker-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} aria-label="搜索模型或服务商" onChange={event => setQuery(event.target.value)}
              placeholder="搜索模型…" type="search" value={query} />
          </label>
          <div className="settings-model-picker-options" id={listId} ref={listRef} role="listbox" aria-label={ariaLabel}>
            {inheritLabel ? (
              <button aria-selected={value === undefined}
                className={`settings-model-picker-option is-inherit${value === undefined ? " is-selected" : ""}`}
                onClick={() => choose(undefined)} role="option" type="button">
                <span className="settings-model-picker-option-check"><Icon name={value === undefined ? "check" : "close"} size={13} /></span>
                <span className="settings-model-picker-option-copy"><strong>{inheritLabel}</strong></span>
              </button>
            ) : null}
            {visibleGroups.map(group => (
              <section className="settings-model-picker-group" key={group.key} role="group" aria-label={group.label}>
                <div className="settings-model-picker-group-heading">
                  <ProviderMark iconId={group.iconId} iconTone={group.iconTone} />
                  <strong>{group.label}</strong>
                </div>
                {group.options.map(option => {
                  const selectedOption = option.value === value;
                  return (
                    <button aria-disabled={option.disabled} aria-selected={selectedOption}
                      className={`settings-model-picker-option${selectedOption ? " is-selected" : ""}`}
                      disabled={option.disabled} key={option.value} onClick={() => choose(option.value)} role="option" type="button"
                      title={`${group.label} · ${option.label}${option.secondary ? ` · ${option.secondary}` : ""}${option.disabled ? " · 未配置" : ""}`}>
                      <span className="settings-model-picker-option-check">{selectedOption ? <Icon name="check" size={13} /> : null}</span>
                      <span className="settings-model-picker-option-copy"><strong>{option.label}</strong></span>
                      {option.trailing || option.disabled ? <small className="settings-model-picker-option-trailing">{option.trailing ?? "未配置"}</small> : null}
                    </button>
                  );
                })}
              </section>
            ))}
            {!visibleGroups.length ? <p className="settings-model-picker-empty" role="status">没有匹配的模型</p> : null}
          </div>
        </div>, portalTarget
      ) : null}
    </div>
  );
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
