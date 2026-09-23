/** 原生文本框的呼吸光标与打字拖尾；只测量独立镜像，不修改文本或输入法选区。 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { promptCaretMotion, promptCaretPosition, promptCaretOffset, type CaretPosition } from "./promptDecorations.js";

export function useBreathingCaret(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  hostRef: RefObject<HTMLDivElement | null>,
  caretRef: RefObject<HTMLDivElement | null>,
  trailRef: RefObject<HTMLDivElement | null>,
  value: string,
  disabled: boolean
): void {
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const input = inputRef.current;
    const host = hostRef.current;
    const caret = caretRef.current;
    const trail = trailRef.current;
    if (!input || !host || !caret || !trail) return;
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;contain:layout style paint;";
    document.body.appendChild(mirror);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forcedColors = window.matchMedia("(forced-colors: active)");
    let previous: CaretPosition | undefined;
    let frame: number | undefined;
    let snapFrame: number | undefined;
    const trails = new Map<Animation, HTMLDivElement>();
    let lastTrailAt = -Infinity;
    let composing = false;
    let compositionPending = false;

    const clearTrails = (): void => {
      for (const [animation, element] of trails) { animation.cancel(); element.remove(); }
      trails.clear();
    };

    const hide = (): void => {
      host.dataset.breathingCaret = "off";
      previous = undefined;
      clearTrails();
    };
    const update = (): void => {
      frame = undefined;
      // 输入法事件只触发装饰重测，不清空旧位置；否则拼音收缩为汉字时会被当成首次定位。
      const offset = promptCaretOffset(input.selectionStart, input.selectionEnd, composing || compositionPending);
      if (document.activeElement !== input || !document.hasFocus() || input.disabled
        || offset === undefined || reducedMotion.matches || forcedColors.matches) return hide();
      if (!composing && input.selectionStart === input.selectionEnd) compositionPending = false;
      const style = getComputedStyle(input);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch", "font-feature-settings", "font-kerning", "line-height", "letter-spacing", "word-spacing", "text-indent", "text-transform", "text-align", "tab-size", "direction", "word-break", "padding"]) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
      }
      // clientWidth 排除滚动条；完整后缀参与换行，末尾零宽字符保留最后一个空行。
      mirror.style.width = `${String(input.clientWidth)}px`;
      mirror.textContent = `${input.value}\u200b`;
      const text = mirror.firstChild;
      if (!text) return hide();
      const range = document.createRange();
      range.setStart(text, Math.min(offset, input.value.length));
      range.collapse(true);
      let measured = range.getBoundingClientRect();
      if (!measured.height) {
        const marker = document.createElement("span");
        marker.textContent = "\u200b";
        range.insertNode(marker);
        measured = marker.getBoundingClientRect();
      }
      const bounds = input.getBoundingClientRect();
      const next = promptCaretPosition(
        { left: bounds.left, top: bounds.top, width: input.clientWidth, height: input.clientHeight },
        host.getBoundingClientRect(), mirror.getBoundingClientRect(),
        // 固定为字体的 1.2 倍，不随拉丁字母/汉字的字形矩形高度跳变。
        { left: measured.left, top: measured.top, height: parseFloat(style.fontSize) * 1.2 },
        { left: input.scrollLeft, top: input.scrollTop }
      );
      if (!next) return hide();
      const motion = promptCaretMotion(previous, next);
      if (snapFrame !== undefined) cancelAnimationFrame(snapFrame);
      caret.dataset.snapping = String(motion.snap);
      caret.style.height = `${String(next.height)}px`;
      caret.style.transform = `translate3d(${String(next.x)}px, ${String(next.y)}px, 0)`;
      if (motion.snap) {
        clearTrails();
        snapFrame = requestAnimationFrame(() => { caret.dataset.snapping = "false"; snapFrame = undefined; });
      }
      const now = performance.now();
      if (motion.trail && now - lastTrailAt >= 32) {
        lastTrailAt = now;
        const segment = document.createElement("div");
        segment.className = "biny-breathing-caret-trail";
        segment.dataset.direction = motion.trail.direction;
        segment.style.left = `${String(motion.trail.left)}px`;
        segment.style.top = `${String(next.y)}px`;
        segment.style.width = `${String(motion.trail.width)}px`;
        segment.style.height = `${String(next.height)}px`;
        trail.appendChild(segment);
        const animation = segment.animate([
          { opacity: 0.6, transform: "scaleX(1)" },
          { opacity: 0, transform: "scaleX(0)" }
        ], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        trails.set(animation, segment);
        animation.onfinish = () => { trails.delete(animation); segment.remove(); };
      }
      previous = next;
      host.dataset.breathingCaret = "on";
    };
    const schedule = (): void => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    const compositionStart = (): void => { composing = true; compositionPending = false; schedule(); };
    // 某些输入法先结束组合、再派发最终 input；这两步之间仍沿用组合尾端。
    const compositionEnd = (): void => { composing = false; compositionPending = true; schedule(); };
    const blur = (): void => { composing = false; compositionPending = false; hide(); };
    const pointerDown = (): void => { compositionPending = false; };
    refresh.current = schedule;
    // 中文上屏可能同时改变换行和高度；重测时保留前一坐标，由纵向位移判断是否瞬移。
    const observer = new ResizeObserver(schedule);
    observer.observe(input);
    const events = ["input", "select", "keyup", "pointerup", "focus"] as const;
    for (const event of events) input.addEventListener(event, schedule);
    input.addEventListener("blur", blur);
    input.addEventListener("pointerdown", pointerDown);
    input.addEventListener("scroll", schedule, { passive: true });
    input.addEventListener("compositionstart", compositionStart);
    input.addEventListener("compositionupdate", schedule);
    input.addEventListener("compositionend", compositionEnd);
    document.addEventListener("selectionchange", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", schedule);
    reducedMotion.addEventListener("change", schedule);
    forcedColors.addEventListener("change", schedule);
    schedule();
    return () => {
      refresh.current = () => undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (snapFrame !== undefined) cancelAnimationFrame(snapFrame);
      observer.disconnect();
      for (const event of events) input.removeEventListener(event, schedule);
      input.removeEventListener("blur", blur);
      input.removeEventListener("pointerdown", pointerDown);
      input.removeEventListener("scroll", schedule);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionupdate", schedule);
      input.removeEventListener("compositionend", compositionEnd);
      document.removeEventListener("selectionchange", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", schedule);
      reducedMotion.removeEventListener("change", schedule);
      forcedColors.removeEventListener("change", schedule);
      hide();
      mirror.remove();
    };
  }, [inputRef, hostRef, caretRef, trailRef]);

  // 发送清空、历史消息回填和补全也会移动光标，但不一定产生原生 input 事件。
  useLayoutEffect(() => { refresh.current(); }, [value, disabled]);
}
