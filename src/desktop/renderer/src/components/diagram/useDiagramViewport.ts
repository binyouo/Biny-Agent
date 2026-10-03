import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const DIAGRAM_MIN_SCALE = .25;
export const DIAGRAM_MAX_SCALE = 4;
const STEP = .25;

/** 图表只在修饰滚轮或独立预览中接管缩放；拖动与双指缩放不影响聊天滚动。 */
export function useDiagramViewport(requireModifierForWheel = true) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => setContainer(node), []);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const positionRef = useRef(position);
  useLayoutEffect(() => { positionRef.current = position; }, [position]);
  const clamp = (value: number) => Math.max(DIAGRAM_MIN_SCALE, Math.min(DIAGRAM_MAX_SCALE, value));
  const zoomIn = () => setScale(value => clamp(value + STEP));
  const zoomOut = () => setScale(value => clamp(value - STEP));
  const reset = () => { setScale(1); setPosition({ x: 0, y: 0 }); };

  useEffect(() => {
    if (!container) return;
    let drag: { x: number; y: number; posX: number; posY: number } | undefined;
    let touchDrag: typeof drag;
    let touchDistance: number | undefined;
    const ignored = (target: EventTarget | null) => target instanceof Element && !!target.closest("[data-zoompan-ignore]");
    const onWheel = (event: WheelEvent) => {
      if (ignored(event.target) || (requireModifierForWheel && !event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      setScale(value => clamp(value + (event.deltaY > 0 ? -STEP : STEP)));
    };
    const onMouseMove = (event: MouseEvent) => { if (drag) setPosition({ x: drag.posX + event.clientX - drag.x, y: drag.posY + event.clientY - drag.y }); };
    const onMouseUp = () => {
      drag = undefined;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || ignored(event.target)) return;
      event.preventDefault();
      drag = { x: event.clientX, y: event.clientY, posX: positionRef.current.x, posY: positionRef.current.y };
      setIsDragging(true);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    };
    const distance = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (ignored(event.target)) return;
      if (event.touches.length === 2) {
        event.preventDefault();
        touchDrag = undefined;
        touchDistance = distance(event.touches);
      } else if (event.touches.length === 1) {
        const touch = event.touches[0]!;
        touchDrag = { x: touch.clientX, y: touch.clientY, posX: positionRef.current.x, posY: positionRef.current.y };
        setIsDragging(true);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && touchDistance !== undefined) {
        event.preventDefault();
        const next = distance(event.touches);
        if (touchDistance > 0) { const ratio = next / touchDistance; setScale(value => clamp(value * ratio)); }
        touchDistance = next;
      } else if (event.touches.length === 1 && touchDrag) {
        event.preventDefault();
        const touch = event.touches[0]!;
        setPosition({ x: touchDrag.posX + touch.clientX - touchDrag.x, y: touchDrag.posY + touch.clientY - touchDrag.y });
      }
    };
    const onTouchEnd = () => { touchDistance = undefined; touchDrag = undefined; setIsDragging(false); };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);
    window.addEventListener("blur", onMouseUp);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
    };
  }, [container, requireModifierForWheel]);
  const isReset = scale === 1 && position.x === 0 && position.y === 0;
  return { containerRef, scale, isDragging, isReset, transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`, zoomIn, zoomOut, reset };
}
