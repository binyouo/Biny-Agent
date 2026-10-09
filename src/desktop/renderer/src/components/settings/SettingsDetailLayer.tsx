/**
 * 设置中心的二级详情层。
 *
 * 它只负责层级交互：进入时聚焦首个控件，捕获 Escape，并在退出后恢复触发控件焦点。
 * 详情内容自己提供 dialog 语义和可访问名称，避免嵌套原生 Dialog。
 */
import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SettingsDetailHostContext } from "./SettingsDetailHostContext.js";

const detailLayerStack: symbol[] = [];

export function SettingsDetailLayer({ children, onClose }: {
  children: React.ReactNode;
  onClose(): void;
}): React.ReactPortal | null {
  const host = useContext(SettingsDetailHostContext);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const layerIdRef = useRef(Symbol("settings-detail-layer"));

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!host) return;
    const layerId = layerIdRef.current;
    detailLayerStack.push(layerId);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const controls = detailControls(backdropRef.current);
    const focusTarget = controls.find(element => element.matches("[data-settings-detail-autofocus], [data-model-dialog-autofocus]"))
      ?? controls.find(element => element.matches("input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']), textarea, select"))
      ?? controls[0]
      ?? backdropRef.current;
    focusTarget?.focus({ preventScroll: true });

    const handleLayerKeys = (event: KeyboardEvent): void => {
      if (detailLayerStack.at(-1) !== layerId) return;
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        // 捕获阶段消费，保证一次 Escape 只关闭当前详情层，而不是继续关闭整个设置中心。
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = detailControls(backdropRef.current);
      if (!focusable.length) { event.preventDefault(); backdropRef.current?.focus(); return; }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0 ? focusable.length - 1 : current - 1
        : current < 0 || current === focusable.length - 1 ? 0 : current + 1;
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener("keydown", handleLayerKeys, true);
    return () => {
      document.removeEventListener("keydown", handleLayerKeys, true);
      const stackIndex = detailLayerStack.lastIndexOf(layerId);
      if (stackIndex >= 0) detailLayerStack.splice(stackIndex, 1);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [host]);

  return host ? createPortal(
    <div
      className="model-dialog-backdrop settings-detail-layer"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseRef.current(); }}
      ref={backdropRef}
      tabIndex={-1}
    >
      {children}
    </div>,
    host
  ) : null;
}

function detailControls(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>(
    "button, input:not([type='hidden']), textarea, select, a[href], summary, [tabindex]"
  ) ?? [])].filter(element => {
    if (element.matches(":disabled, [tabindex='-1'], [aria-disabled='true']") || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(ancestor);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
      if (ancestor.matches("details:not([open])") && !ancestor.querySelector("summary")?.contains(element)) return false;
    }
    return true;
  });
}
