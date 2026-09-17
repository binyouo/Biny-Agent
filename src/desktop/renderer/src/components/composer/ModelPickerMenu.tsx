/**
 * Composer 的模型与推理强度选择器。
 *
 * 一级菜单只包含两个稳定的入口；二级菜单通过 portal 独立定位，避免模型列表长度或推理
 * 档位数量改变时撑大一级菜单，进而让锚点发生位移。二级菜单的碰撞处理也只作用于自己。
 */
import { autoUpdate } from "@floating-ui/dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, RefObject } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import type { ThinkingSelection } from "../../../../../llm/modelThinking.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { Icon } from "../Icon.js";

type PickerSection = "model" | "thinking";

interface ModelGroup {
  key: string;
  label: string;
  providerAlias: string;
  models: ModelChoice[];
}

interface SubmenuPosition {
  left: number;
  top: number;
}

interface ParentPosition extends SubmenuPosition {
  origin: "bottom-left" | "bottom-right" | "top-left" | "top-right";
}

const VIEWPORT_PADDING = 8;
const SUBMENU_GAP = 2;
const SUBMENU_MAX_HEIGHT = 400;

export function ModelPickerMenu({
  anchorRef,
  currentAlias,
  currentModelName,
  currentThinking,
  models,
  onClose,
  onSelectModel,
  onSelectThinking,
  open,
  thinkingLevels,
  unsetLabel
}: {
  anchorRef: RefObject<HTMLElement | null>;
  currentAlias?: string;
  currentModelName: string;
  currentThinking?: ThinkingSelection;
  models: ModelChoice[];
  onClose(): void;
  onSelectModel(alias: string): void;
  onSelectThinking(thinking: ThinkingSelection): void;
  open: boolean;
  thinkingLevels: ThinkingSelection[];
  unsetLabel?: string;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [activeSection, setActiveSection] = useState<PickerSection>();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [parentPosition, setParentPosition] = useState<ParentPosition>();
  const [submenuPosition, setSubmenuPosition] = useState<SubmenuPosition>();
  const primaryRef = useRef<HTMLDivElement>(null);
  const parentSurfaceRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupModels(models), [models]);
  // 流动悬停：一级菜单的两个入口行也交给统一的高亮绘制。
  const primaryHover = useFluidHoverItems(primaryRef, ".model-picker-entry");

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    setPortalTarget(anchorRef.current?.closest("dialog") ?? document.body);
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    // 在浏览器绘制新一轮菜单前清空上一次的子菜单，避免重新打开时先闪过模型列表。
    setActiveSection(undefined);
    setParentPosition(undefined);
    setSubmenuPosition(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || primaryRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
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

  useLayoutEffect(() => {
    if (!presence.present) {
      setParentPosition(undefined);
      return;
    }

    const measurePosition = (): void => {
      const anchor = anchorRef.current;
      const surface = parentSurfaceRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const surfaceRect = surface?.getBoundingClientRect();
      const gap = 8;
      // 首帧菜单还没有完成布局时使用 CSS 的稳定尺寸，避免因为 width/height 为 0
      // 让定位计算失去参照；完成定位前由 parentStyle 隐藏面板。
      const width = surface?.offsetWidth || surfaceRect?.width || 232;
      const height = surface?.offsetHeight || surfaceRect?.height || 96;
      const roomAbove = anchorRect.top - gap;
      const roomBelow = window.innerHeight - anchorRect.bottom - gap;
      const placeAbove = roomAbove >= height || roomAbove >= roomBelow;
      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
      const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
      const preferredLeft = anchorRect.right - width;
      const preferredTop = placeAbove ? anchorRect.top - height - gap : anchorRect.bottom + gap;
      const next: ParentPosition = {
        left: clamp(preferredLeft, VIEWPORT_PADDING, maxLeft),
        origin: `${placeAbove ? "bottom" : "top"}-left`,
        top: clamp(preferredTop, VIEWPORT_PADDING, maxTop)
      };
      setParentPosition((current) => current?.left === next.left && current.origin === next.origin && current.top === next.top ? current : next);
    };
    const anchor = anchorRef.current;
    const surface = parentSurfaceRef.current;
    if (!anchor || !surface) return;
    // 队列、附件和状态区的高度变化只会移动按钮，不一定触发 ResizeObserver。
    // layoutShift 让一级菜单在这类纯位移中也持续跟随 Composer 锚点。
    return autoUpdate(anchor, surface, measurePosition, {
      ancestorResize: true,
      ancestorScroll: true,
      elementResize: true,
      layoutShift: true
    });
  }, [anchorRef, open, portalTarget, presence.present, thinkingLevels.length]);

  useLayoutEffect(() => {
    // 一级菜单还没有完成定位时，不给子菜单计算临时坐标；否则子菜单会被 clamp
    // 到视口左上角，并在关闭退场时出现一次错误闪烁。
    if (!presence.present || !parentPosition || !activeSection) {
      setSubmenuPosition(undefined);
      return;
    }

    const measurePosition = (): void => {
      const primary = primaryRef.current;
      const submenu = submenuRef.current;
      if (!primary || !submenu) return;
      const parentRect = primary.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const width = submenu.offsetWidth || submenuRect.width;
      // Portal 根节点在 fixed + max-height 的首帧可能报告内容总高度，而真正可见区域
      // 已由 CSS 限制为 400px；定位必须使用可见高度，否则 maxTop 会退化成 8px。
      const measuredHeight = submenu.offsetHeight || submenuRect.height || SUBMENU_MAX_HEIGHT;
      const height = Math.min(measuredHeight, SUBMENU_MAX_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2);
      if (!width || !height) return;

      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
      const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
      const rightLeft = parentRect.right + SUBMENU_GAP;
      const leftLeft = parentRect.left - SUBMENU_GAP - width;
      const preferredLeft = rightLeft <= maxLeft || leftLeft < VIEWPORT_PADDING ? rightLeft : leftLeft;
      // 子菜单与一级菜单顶部对齐；组合定位已经为它们预留了共同的垂直空间，长列表
      // 只在自身内部滚动，避免出现截图中“父面板在底部、列表跑到顶部”的断裂。
      const preferredTop = parentRect.top;
      setSubmenuPosition((current) => {
        const next = {
          left: clamp(preferredLeft, VIEWPORT_PADDING, maxLeft),
          top: clamp(preferredTop, VIEWPORT_PADDING, maxTop)
        };
        return current?.left === next.left && current.top === next.top ? current : next;
      });
    };
    const primary = primaryRef.current;
    const submenu = submenuRef.current;
    if (!primary || !submenu) return;
    return autoUpdate(primary, submenu, measurePosition, {
      ancestorResize: true,
      ancestorScroll: true,
      elementResize: true,
      layoutShift: true
    });
  }, [activeSection, models, open, parentPosition, portalTarget, presence.present, thinkingLevels]);

  if (typeof document === "undefined" || !presence.present) return null;

  const parentStyle: CSSProperties = {
    bottom: "auto",
    left: parentPosition?.left,
    maxHeight: "calc(100vh - 16px)",
    maxWidth: "calc(100vw - 16px)",
    position: "fixed",
    right: "auto",
    top: parentPosition?.top,
    visibility: parentPosition ? "visible" : "hidden",
    zIndex: 160
  };
  const submenuStyle: CSSProperties = {
    bottom: "auto",
    left: submenuPosition?.left,
    position: "fixed",
    right: "auto",
    top: submenuPosition?.top,
    visibility: submenuPosition ? "visible" : "hidden",
    zIndex: 161
  };

  return (
    <>
      {createPortal(
        <div
          className={`composer-popover biny-composer-popover model-picker-popover ${presenceClass(presence.phase)}`}
          data-origin={parentPosition?.origin ?? "bottom-left"}
          data-popover-phase={presence.phase}
          ref={parentSurfaceRef}
          style={parentStyle}
        >
          <div aria-label="模型与推理强度" className="model-picker-primary" ref={primaryRef} role="menu" {...primaryHover.handlers}>
            <FluidHoverHighlight hover={primaryHover} className="has-row-radius" />
            <div
              aria-expanded={activeSection === "model"}
              aria-haspopup="menu"
              className={`model-picker-entry${activeSection === "model" ? " is-active" : ""}`}
              onMouseEnter={() => setActiveSection("model")}
              role="menuitem"
            >
              <span className="model-picker-entry-label">模型</span>
              <span className="model-picker-entry-value">{currentModelName}</span>
              <Icon name="chevron" size={12} />
            </div>
            {thinkingLevels.length ? (
              <div
                aria-expanded={activeSection === "thinking"}
                aria-haspopup="menu"
                className={`model-picker-entry${activeSection === "thinking" ? " is-active" : ""}`}
                onMouseEnter={() => setActiveSection("thinking")}
                role="menuitem"
              >
                <span className="model-picker-entry-label">推理强度</span>
                <span className="model-picker-entry-value">{currentThinking ?? "默认"}</span>
                <Icon name="chevron" size={12} />
              </div>
            ) : null}
          </div>
        </div>,
        portalTarget ?? document.body
      )}
      {activeSection
        ? createPortal(
            <div
              aria-label={activeSection === "model" ? "选择模型" : "选择推理强度"}
              className={`composer-popover biny-composer-popover model-picker-submenu-portal ${presenceClass(presence.phase)}`}
              data-composer-menu="model"
              data-popover-phase={presence.phase}
              ref={submenuRef}
              role="menu"
              style={submenuStyle}
            >
              {activeSection === "model" ? (
                <ModelSubmenu currentAlias={currentAlias} groups={groups} onSelect={onSelectModel} unsetLabel={unsetLabel} />
              ) : (
                <ThinkingSubmenu current={currentThinking} levels={thinkingLevels} onSelect={onSelectThinking} />
              )}
            </div>,
            portalTarget ?? document.body
          )
        : null}
    </>
  );
}

function ModelSubmenu({ currentAlias, groups, onSelect, unsetLabel }: { currentAlias?: string; groups: ModelGroup[]; onSelect(alias: string): void; unsetLabel?: string }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // 流动悬停：容器内按选择器自动注册模型选项，搜索过滤后自动重注册。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHoverItems(listRef, ".model-picker-submenu-option");
  const filteredGroups = useMemo(() => filterModelGroups(groups, query), [groups, query]);
  const duplicateLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(group.label, (counts.get(group.label) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([label]) => label));
  }, [groups]);

  useEffect(() => {
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  return (
    <div className="model-picker-submenu" ref={listRef} {...hover.handlers}>
      <FluidHoverHighlight hover={hover} className="has-row-radius" />
      <div className="model-picker-submenu-heading">模型</div>
      <label className="model-search model-picker-search">
        <Icon name="search" size={13} />
        <input
          aria-label="搜索模型"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型…"
          ref={searchRef}
          type="search"
          value={query}
        />
      </label>
      {unsetLabel ? (
        <button
          aria-checked={currentAlias === undefined}
          className={`model-picker-submenu-option${currentAlias === undefined ? " is-selected" : ""}`}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onSelect("");
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect("");
          }}
          role="menuitemradio"
          type="button"
        >
          <span className="model-picker-option-label"><strong>{unsetLabel}</strong></span>
          {currentAlias === undefined ? <Icon name="check" size={14} /> : null}
        </button>
      ) : null}
      {filteredGroups.map((group) => (
        <div className="model-picker-submenu-group" key={group.key}>
          <div className="model-picker-group-heading">
            <span>{group.label}</span>
            {duplicateLabels.has(group.label) ? <small>{group.providerAlias}</small> : null}
          </div>
          {group.models.map((model) => {
            const selected = model.alias === currentAlias;
            return (
              <button
                aria-checked={selected}
                className={`model-picker-submenu-option${selected ? " is-selected" : ""}`}
                key={model.alias}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(model.alias);
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(model.alias);
                }}
                role="menuitemradio"
                type="button"
              >
                <span className="model-picker-option-label">
                  <strong>{model.displayName}</strong>
                </span>
                {selected ? <Icon name="check" size={14} /> : null}
              </button>
            );
          })}
        </div>
      ))}
      {!filteredGroups.length ? <div className="model-picker-submenu-empty">{groups.length ? "没有匹配的模型" : "没有可用模型"}</div> : null}
    </div>
  );
}

function ThinkingSubmenu({ current, levels, onSelect }: { current?: ThinkingSelection; levels: ThinkingSelection[]; onSelect(thinking: ThinkingSelection): void }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHoverItems(listRef, ".model-effort-options button");
  return (
    <div className="model-picker-submenu" ref={listRef} {...hover.handlers}>
      <FluidHoverHighlight hover={hover} className="has-row-radius" />
      <div className="model-picker-submenu-heading">推理强度</div>
      <div className="model-effort-options">
        {levels.map((level) => (
          <button
            aria-checked={level === current}
            className={level === current ? "is-selected" : undefined}
            key={level}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onSelect(level);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect(level);
            }}
            role="menuitemradio"
            type="button"
          >
            <span>{level}</span>
            {level === current ? <Icon name="check" size={14} /> : null}
          </button>
        ))}
      </div>
    </div>
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
      providerAlias: model.provider,
      models: []
    };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function filterModelGroups(groups: ModelGroup[], query: string): ModelGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return groups;
  return groups.flatMap((group) => {
    const providerText = `${group.label} ${group.providerAlias}`.toLocaleLowerCase();
    if (providerText.includes(normalized)) return [group];
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
    "openai-codex": "OpenAI Codex",
    "opencode-ai": "OpenCode",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
