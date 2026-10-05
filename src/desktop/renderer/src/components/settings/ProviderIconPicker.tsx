/**
 * 服务商图标选择器。对齐 Alma 的 ProviderIconPicker：触发按钮 + 搜索框 + 7 列图标网格。
 *
 * 两点照参照的 `w-[var(--radix-popover-trigger-width)] min-w-[300px]`：
 * 弹层宽度跟随触发按钮且不小于 300px；弹层走 portal——设置面板本身是滚动容器，
 * 就地定位会被裁掉。
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClosingPresence } from "../../useClosingPresence.js";
import { Icon } from "../Icon.js";
import { ProviderBrandIcon } from "../ProviderBrandIcon.js";
import { getCachedProviderIconData, loadProviderIconData, type ProviderIconData } from "../ProviderIconData.js";

const MIN_POPOVER_WIDTH = 300;
const POPOVER_GAP = 4;
const VIEWPORT_PADDING = 8;

interface PopoverBox {
  left: number;
  top: number;
  width: number;
}

export function ProviderIconPicker({ value, onChange, className, defaultIcon, triggerId }: {
  value?: string | null;
  onChange(iconId: string | null): void;
  className?: string;
  defaultIcon?: React.ReactNode;
  /** 触发按钮的 id，供外层 <label htmlFor> 关联；不传就没有关联。 */
  triggerId?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProviderIconData["list"] | null>(() => getCachedProviderIconData()?.list ?? null);
  const [search, setSearch] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<PopoverBox>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const presence = useClosingPresence(open);
  const popoverId = useId();

  // 数据只在第一次打开时拉；已加载过就直接用缓存，避免重复解析 480KB。
  useEffect(() => {
    if (!open || list) return;
    let active = true;
    void loadProviderIconData().then((loaded) => { if (active) setList(loaded.list); });
    return () => { active = false; };
  }, [open, list]);

  // 每次打开都从空查询开始，沿用上一次的搜索词会让人以为图标丢了。
  useEffect(() => { if (open) setSearch(""); }, [open]);

  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;
    // 设置中心用原生 <dialog> 承载时，弹层必须挂进 dialog 内部才不会被顶层盖住。
    setPortalTarget(triggerRef.current?.closest("dialog") ?? document.body);
  }, [open]);

  useLayoutEffect(() => {
    if (!presence.present) {
      setBox(undefined);
      return;
    }
    const anchor = triggerRef.current;
    if (!anchor) return;
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect();
      const surface = surfaceRef.current;
      const width = Math.max(rect.width, MIN_POPOVER_WIDTH);
      const height = surface?.offsetHeight ?? 0;
      const roomBelow = window.innerHeight - rect.bottom - POPOVER_GAP;
      const roomAbove = rect.top - POPOVER_GAP;
      const placeAbove = height > 0 && roomBelow < height && roomAbove > roomBelow;
      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
      setBox({
        left: Math.min(Math.max(rect.left, VIEWPORT_PADDING), maxLeft),
        top: placeAbove ? Math.max(VIEWPORT_PADDING, rect.top - height - POPOVER_GAP) : rect.bottom + POPOVER_GAP,
        width
      });
    };
    measure();
    // 首帧量到的高度可能是 0（字体/网格还没排完），面板自身尺寸变化要能触发重算。
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (observer) {
      observer.observe(anchor);
      if (surfaceRef.current) observer.observe(surfaceRef.current);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [presence.present]);

  // 点外部或 Esc 关闭。pointerdown 早于 click，先判定再让触发按钮自己切换开关。
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || surfaceRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!list) return [];
    const query = search.trim().toLowerCase();
    if (!query) return list;
    return list.filter((item) => item.title.toLowerCase().includes(query) || item.id.toLowerCase().includes(query));
  }, [list, search]);

  // 数据未加载时用 value 自身兜底，别把图标显示成空字符串。
  const selectedTitle = useMemo(() => list?.find((item) => item.id === value)?.title ?? value, [list, value]);
  const defaultGlyph = defaultIcon ?? <Icon className="provider-icon-trigger-glyph is-default" name="layout-grid" size={20} />;

  return (
    <div className={className ? "provider-icon-picker " + className : "provider-icon-picker"}>
      <button
        aria-controls={presence.present ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="provider-icon-trigger"
        id={triggerId}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        {value
          ? <ProviderBrandIcon className="provider-icon-trigger-glyph is-selected" fallback={defaultGlyph} iconId={value} />
          : defaultGlyph}
        <span className="provider-icon-trigger-label">{value ? selectedTitle : "默认图标"}</span>
        <Icon className="provider-icon-trigger-chevron" name="chevron" size={16} />
      </button>

      {presence.present && typeof document !== "undefined" ? createPortal(
        <div
          className="provider-icon-popover"
          data-popover-phase={presence.phase}
          id={popoverId}
          ref={surfaceRef}
          role="dialog"
          style={{
            left: box?.left ?? -10000,
            top: box?.top ?? -10000,
            visibility: box ? "visible" : "hidden",
            width: box?.width ?? MIN_POPOVER_WIDTH
          }}
        >
          <div className="provider-icon-search">
            <Icon name="search" size={16} />
            <input
              aria-label="搜索图标…"
              autoFocus
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索图标…"
              value={search}
            />
          </div>
          <div className="provider-icon-body">
            {!list ? (
              <div className="provider-icon-loading">
                <Icon className="provider-icon-spinner" name="loader" size={16} />
                正在加载图标…
              </div>
            ) : (
              <div className="provider-icon-grid">
                <button
                  aria-pressed={!value}
                  className={"provider-icon-cell is-default" + (!value ? " is-selected" : "")}
                  onClick={() => { onChange(null); setOpen(false); }}
                  title="默认图标"
                  type="button"
                >
                  {defaultGlyph}
                </button>
                {filtered.map((item) => (
                  <button
                    aria-pressed={value === item.id}
                    className={"provider-icon-cell" + (value === item.id ? " is-selected" : "")}
                    key={item.id}
                    onClick={() => { onChange(item.id); setOpen(false); }}
                    title={item.title}
                    type="button"
                  >
                    <ProviderBrandIcon iconId={item.id} />
                  </button>
                ))}
                {filtered.length === 0 ? <div className="provider-icon-empty">未找到图标</div> : null}
              </div>
            )}
          </div>
        </div>,
        portalTarget ?? document.body
      ) : null}
    </div>
  );
}
