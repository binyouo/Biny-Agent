import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * 呼吸灯光标 + 移动拖尾（参考应用自绘 caret 系统）。
 *
 * contenteditable 的原生 caret 只会机械闪烁，而且样式由系统接管、无法加
 * 辉光。这里在编辑器容器上叠加一个自绘 caret：通过 Selection 拿到光标的
 * 屏幕矩形，把自定义元素定位过去；原生 caret 用 CSS（caret-color:
 * transparent）在自绘 caret 可见时隐藏。
 *
 * 光标水平移动（打字、拼音上屏）时在旧位置铺一条渐变拖尾（prompt-caret-trail），
 * .18s 内收束消失；拖尾宽度按位移钳制（最大 28px），方向决定渐变朝向。
 *
 * 可见性通过容器上的 data-breathing-caret="on|off" 表达，CSS 负责动画，
 * 因此输入过程中动画相位不会因为重定位而重置。
 */
export function useBreathingCaret(
  editorRef: RefObject<HTMLDivElement | null>,
  caretRef: RefObject<HTMLDivElement | null>,
  trailRef?: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const editor = editorRef.current;
    const caret = caretRef.current;
    const trail = trailRef?.current ?? null;
    if (!editor || !caret) return;

    // 上一帧光标位置：判断换行跳变与水平位移；隐藏后重置
    let lastX: number | null = null;
    let lastY: number | null = null;
    let trailTimer: number | undefined;

    const getEditable = () =>
      editor.querySelector<HTMLElement>('[contenteditable="true"]');

    const hide = () => {
      lastX = null;
      lastY = null;
      if (trail) trail.style.opacity = "0";
      if (editor.dataset.breathingCaret !== "off") {
        editor.dataset.breathingCaret = "off";
      }
    };

    // 折叠选区在多数情况下能直接给出矩形；空编辑器（或 caret 落在元素
    // 边界）时拿不到，临时插一个零宽字符测量后移除并还原选区。
    const measure = (range: Range): DOMRect | null => {
      const rects = range.getClientRects();
      for (const rect of rects) {
        if (rect.height > 0) return rect;
      }
      const node = range.startContainer;
      const offset = range.startOffset;
      const marker = document.createTextNode("\u200B");
      range.insertNode(marker);
      const markerRange = document.createRange();
      markerRange.selectNode(marker);
      let rect: DOMRect | null = null;
      rect = markerRange.getClientRects().item(0);
      markerRange.detach();
      marker.parentNode?.removeChild(marker);
      // 合并被拆开的文本节点，避免在镜像层留下脏结构
      (node.nodeType === Node.TEXT_NODE ? node.parentNode : node)?.normalize();
      const sel = window.getSelection();
      try {
        sel?.collapse(node, Math.min(offset, node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length));
      } catch {
        // 外部（如受控重渲染）已重建 DOM 时放弃恢复，下一次 selectionchange 会纠正
      }
      return rect;
    };

    // 水平移动拖尾：在旧位置铺 [min(|dx|, 28)] 宽的渐变条并重启动画。
    const spawnTrail = (fromX: number, toX: number, y: number, height: number): void => {
      if (!trail) return;
      const delta = Math.abs(toX - fromX);
      if (delta < 1.5) return;
      const width = Math.min(delta, 28);
      const left = Math.min(fromX, toX);
      const direction = toX > fromX ? "right" : "left";
      trail.style.opacity = "1";
      trail.style.left = `${String(left)}px`;
      trail.style.top = `${String(y)}px`;
      trail.style.height = `${String(height)}px`;
      trail.style.width = `${String(width)}px`;
      trail.style.transform = "scaleX(1)";
      if (trail.dataset.direction !== direction) trail.dataset.direction = direction;
      // 重启动画：先置 none 并强制 reflow，再清空让 CSS 类声明接管。
      trail.style.animation = "none";
      void trail.offsetHeight;
      trail.style.animation = "";
      if (trailTimer !== undefined) window.clearTimeout(trailTimer);
      trailTimer = window.setTimeout(() => {
        trail.style.opacity = "0";
      }, 200);
    };

    const update = () => {
      const editable = getEditable();
      if (!editable || document.activeElement !== editable) return hide();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return hide();
      const range = sel.getRangeAt(0);
      if (!editable.contains(range.startContainer)) return hide();

      let rect: DOMRect | null = null;
      if (range.collapsed) {
        rect = measure(range);
      } else if (composing) {
        // IME 组合中：选区覆盖整段拼音，光标应跟到 focus 端（正在编辑的位置）。
        // 组合期间绝不能改 DOM（会打断输入法），拿不到矩形就用组合区间右缘兜底。
        if (sel.focusNode && editable.contains(sel.focusNode)) {
          const focusRange = document.createRange();
          try {
            focusRange.setStart(sel.focusNode, sel.focusOffset);
            focusRange.collapse(true);
            const rects = focusRange.getClientRects();
            for (const r of rects) {
              if (r.height > 0) { rect = r; break; }
            }
          } finally {
            focusRange.detach();
          }
        }
        if (!rect) {
          const rects = range.getClientRects();
          const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
          if (last) rect = new DOMRect(last.right, last.top, 0, last.height);
        }
      } else {
        // 普通选区（拖选文字）：隐藏光标
        return hide();
      }
      if (!rect) return hide();

      const host = editor.getBoundingClientRect();
      // 光标略短于行高，垂直居中，观感更接近原生 caret
      const caretHeight = Math.max(14, Math.round(rect.height * 0.82));
      const x = Math.round(rect.left - host.left);
      const y = Math.round(rect.top - host.top + (rect.height - caretHeight) / 2);
      // 换行（y 跳变）或隐藏后重新出现时瞬移，避免光标斜滑过去；
      // 同行的水平移动（打字、拼音上屏）交给 CSS transition 滑行过去，并铺一条拖尾。
      const snap = lastY === null || Math.abs(y - lastY) > rect.height * 0.6;
      if (snap) caret.classList.add("is-snapping");
      else if (lastX !== null) spawnTrail(lastX, x, y, caretHeight);
      caret.style.height = `${String(caretHeight)}px`;
      caret.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
      if (snap) {
        // 强制 reflow，让本次位移在 transition: none 下立即生效
        void caret.offsetHeight;
        caret.classList.remove("is-snapping");
      }
      lastX = x;
      lastY = y;
      if (editor.dataset.breathingCaret !== "on") {
        editor.dataset.breathingCaret = "on";
      }
    };

    let frame = 0;
    // IME 组合输入期间（拼音上屏前）选区非折叠，需要特殊处理光标位置
    let composing = false;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const onCompositionStart = () => { composing = true; schedule(); };
    const onCompositionEnd = () => { composing = false; schedule(); };

    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("blur", hide);
    editor.addEventListener("input", schedule, true);
    editor.addEventListener("keyup", schedule, true);
    editor.addEventListener("mouseup", schedule);
    editor.addEventListener("scroll", schedule, true);
    editor.addEventListener("compositionstart", onCompositionStart, true);
    editor.addEventListener("compositionupdate", schedule, true);
    editor.addEventListener("compositionend", onCompositionEnd, true);

    const observer = new ResizeObserver(schedule);
    const editable = getEditable();
    if (editable) observer.observe(editable);
    observer.observe(editor);

    schedule();

    return () => {
      cancelAnimationFrame(frame);
      if (trailTimer !== undefined) window.clearTimeout(trailTimer);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("blur", hide);
      editor.removeEventListener("input", schedule, true);
      editor.removeEventListener("keyup", schedule, true);
      editor.removeEventListener("mouseup", schedule);
      editor.removeEventListener("scroll", schedule, true);
      editor.removeEventListener("compositionstart", onCompositionStart, true);
      editor.removeEventListener("compositionupdate", schedule, true);
      editor.removeEventListener("compositionend", onCompositionEnd, true);
      observer.disconnect();
    };
  }, [editorRef, caretRef, trailRef]);
}
