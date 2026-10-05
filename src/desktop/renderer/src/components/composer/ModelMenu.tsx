/**
 * 模型选择菜单。
 *
 * 设置中心的记忆模型需要在同一个模型 ID 出现在多个服务商时仍能辨认来源，因此菜单
 * 按连接分组，并把搜索范围覆盖到服务商、别名和真实模型 ID。Composer 当前使用独立的
 * `ModelPickerMenu`，这里保留给设置页的单层模型选择场景。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEventHandler, RefObject } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { ProviderBrandIcon } from "../ProviderBrandIcon.js";
import { resolveProviderIconId } from "../../providerIconIds.js";
import { ComposerPopover } from "./ComposerPopover.js";

interface ModelGroup {
  key: string;
  label: string;
  iconTone: string;
  /** 目录自带品牌图标的 id；没有就留给手写字形兜底。 */
  iconId?: string;
  providerAlias: string;
  models: ModelChoice[];
}

export function ModelMenu({
  anchorRef,
  models,
  currentAlias,
  open,
  onChange,
  onClose,
  onPointerEnter,
  onPointerLeave,
  unsetLabel
}: {
  anchorRef: RefObject<HTMLElement | null>;
  models: ModelChoice[];
  currentAlias?: string;
  open: boolean;
  onChange(alias: string): void;
  onClose?(): void;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  unsetLabel?: string;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 流动悬停：模型选项按选择器自动注册，搜索过滤后自动重注册。
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsHover = useFluidHoverItems(optionsRef, ".model-option");
  const [query, setQuery] = useState("");
  const allGroups = useMemo(() => groupModels(models), [models]);
  const groups = useMemo(() => filterGroups(allGroups, query), [allGroups, query]);
  const duplicateLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of allGroups) counts.set(group.label, (counts.get(group.label) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label));
  }, [allGroups]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || !onClose) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      // 菜单挂在设置中心的原生 <dialog> 内部时，dialog 自己的 keydown 监听会在冒泡阶段
      // 处理 Escape 并关闭整个设置中心。这里在捕获阶段消费掉事件，保证一次 Escape 只关菜单。
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [anchorRef, onClose, open]);

  if (!presence.present) return null;

  return (
    <ComposerPopover
      anchorRef={anchorRef}
      className={`t-dropdown composer-popover biny-composer-popover model-menu ${presenceClass(presence.phase)}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      phase={presence.phase}
    >
      <div aria-label="选择模型" className="model-menu-main" ref={menuRef} role="menu">
        <label className="model-search">
          <Icon name="search" size={14} />
          <input
            aria-label="搜索模型"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型…"
            ref={searchRef}
            type="search"
            value={query}
          />
        </label>
        <div className="model-options-scroll" ref={optionsRef} {...optionsHover.handlers}>
          <FluidHoverHighlight hover={optionsHover} className="has-row-radius" />
          {unsetLabel ? (
            <button
              aria-checked={currentAlias === undefined}
              className={`menu-option model-option${currentAlias === undefined ? " is-selected" : ""}`}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onChange("");
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange("");
              }}
              role="menuitemradio"
              type="button"
            >
              <span className="model-option-leading">
                <span className="model-option-copy"><strong>{unsetLabel}</strong></span>
              </span>
              <span className="model-option-check">{currentAlias === undefined ? <Icon name="check" size={14} /> : null}</span>
            </button>
          ) : null}
          {groups.map((group) => (
            <div className="model-group" key={group.key}>
              <div className="model-group-heading">
                <span className="model-option-brand"><ProviderBrandIcon className="provider-logo" fallback={<ProviderBrandGlyph type={group.iconTone} />} iconId={group.iconId} /></span>
                <span>{group.label}</span>
                {duplicateLabels.has(group.label) ? <small>{group.providerAlias}</small> : null}
              </div>
              {group.models.map((model) => {
                const selected = model.alias === currentAlias;
                return (
                  <button
                    aria-checked={selected}
                    className={`menu-option model-option${selected ? " is-selected" : ""}`}
                    key={model.alias}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      onChange(model.alias);
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onChange(model.alias);
                    }}
                    role="menuitemradio"
                    type="button"
                  >
                    <span className="model-option-leading">
                      <span className="model-option-copy">
                        <strong>{model.displayName}</strong>
                        {model.model !== model.displayName ? <small>{model.model}</small> : null}
                      </span>
                    </span>
                    <span className="model-option-check">{selected ? <Icon name="check" size={14} /> : null}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {!groups.length ? <div className="menu-empty">{models.length ? "没有匹配的模型" : "没有可用模型"}</div> : null}
        </div>
      </div>
    </ComposerPopover>
  );
}

function groupModels(models: ModelChoice[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    if (model.showInPicker === false) continue;
    const catalog = catalogForConnection(
      { provider: model.provider, providerType: model.providerType },
      model.baseUrl
    );
    const key = `${model.providerType}:${model.provider}:${model.baseUrl ?? ""}`;
    const group = groups.get(key) ?? {
      key,
      label: catalog?.label ?? providerLabel(model.provider),
      iconTone: catalog?.iconTone ?? model.providerType,
      iconId: resolveProviderIconId(undefined, catalog?.id),
      providerAlias: model.provider,
      models: []
    };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function filterGroups(groups: ModelGroup[], query: string): ModelGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return groups;
  return groups.flatMap((group) => {
    const groupText = `${group.label} ${group.providerAlias}`.toLocaleLowerCase();
    if (groupText.includes(normalized)) return [group];
    const filteredModels = group.models.filter((model) => (
      `${model.displayName} ${model.alias} ${model.model}`.toLocaleLowerCase().includes(normalized)
    ));
    return filteredModels.length ? [{ ...group, models: filteredModels }] : [];
  });
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Google Gemini",
    kimi: "Kimi",
    moonshot: "Moonshot",
    ollama: "Ollama",
    openai: "OpenAI",
    "openai-compatible": "OpenAI Compatible",
    "openai-codex": "OpenAI Codex",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
