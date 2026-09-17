/**
 * 标题删字尘粒（spawnTitleDeleteDust 移植）。
 *
 * 删字打字机每删掉一段字符时，在标题右缘生成：
 * - 一段「幽灵文本」：原位淡出 + 上浮 fontSize*0.45 + blur 2.5px，240ms cubic-bezier(.3,0,.55,1)；
 * - 若干尘点（数量 min(2 + 字符数*2, 10)）：1.2–2.5px 圆点，随机向左上飘散并缩到 0.25，
 *   300–560ms cubic-bezier(.16,1,.3,1)。
 * 全部挂在 body 上的全屏 pointer-events:none 覆盖层（data-title-dust-layer），
 * 子元素上限 140；尊重 prefers-reduced-motion。
 */

let overlay: HTMLDivElement | null = null;
let measureCtx: CanvasRenderingContext2D | null = null;
let reducedMotionQuery: MediaQueryList | null = null;
const MAX_OVERLAY_CHILDREN = 140;

function getOverlay(): HTMLDivElement {
  if (overlay && overlay.isConnected) return overlay;
  overlay = document.createElement("div");
  overlay.setAttribute("data-title-dust-layer", "");
  overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
  document.body.appendChild(overlay);
  return overlay;
}

function prefersReducedMotion(): boolean {
  if (!reducedMotionQuery) reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches;
}

function measureTextWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx || !font) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function animateAndRemove(el: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
  el.animate(keyframes, options).onfinish = () => {
    el.remove();
  };
  const duration = typeof options.duration === "number" ? options.duration : 600;
  window.setTimeout(() => {
    el.remove();
  }, duration + 3000);
}

export function spawnTitleDeleteDust(textEl: HTMLElement, clipEl: HTMLElement, removedText: string): void {
  if (!removedText || prefersReducedMotion()) return;
  const rect = textEl.getBoundingClientRect();
  const clipRect = clipEl.getBoundingClientRect();
  // 标题已被截断（删到超出可视右缘）或零宽时不喷尘。
  if (rect.right > clipRect.right + 1 || rect.width === 0) return;
  const layer = getOverlay();
  if (layer.childElementCount > MAX_OVERLAY_CHILDREN) return;
  const cs = window.getComputedStyle(textEl);
  const font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
  const removedWidth = Math.min(measureTextWidth(removedText, font), rect.width);
  const fontSize = Number.parseFloat(cs.fontSize) || 14;
  const midY = rect.top + rect.height / 2;

  const ghost = document.createElement("span");
  ghost.textContent = removedText;
  ghost.style.cssText = `position:fixed;left:${String(rect.right - removedWidth)}px;top:${String(rect.top)}px;height:${String(rect.height)}px;display:inline-flex;align-items:center;font:${font};color:${cs.color};white-space:pre;will-change:transform,opacity,filter;`;
  layer.appendChild(ghost);
  animateAndRemove(
    ghost,
    [
      { opacity: 0.75, transform: "translateY(0)", filter: "blur(0px)" },
      { opacity: 0, transform: `translateY(${String(-fontSize * 0.45)}px)`, filter: "blur(2.5px)" }
    ],
    { duration: 240, easing: "cubic-bezier(0.3, 0, 0.55, 1)", fill: "forwards" }
  );

  const dotCount = Math.min(2 + removedText.length * 2, 10);
  for (let i = 0; i < dotCount; i += 1) {
    const dot = document.createElement("span");
    const size = 1.2 + Math.random() * 1.3;
    const startX = rect.right - Math.random() * removedWidth;
    const startY = midY + (Math.random() - 0.5) * fontSize * 0.7;
    dot.style.cssText = `position:fixed;left:${String(startX)}px;top:${String(startY)}px;width:${String(size)}px;height:${String(size)}px;border-radius:50%;background:${cs.color};will-change:transform,opacity;`;
    layer.appendChild(dot);
    const dx = (Math.random() - 0.65) * fontSize * 1.1;
    const dy = -(fontSize * 0.4 + Math.random() * fontSize * 0.9);
    animateAndRemove(
      dot,
      [
        { opacity: 0.85, transform: "translate(0, 0) scale(1)" },
        { opacity: 0, transform: `translate(${String(dx)}px, ${String(dy)}px) scale(0.25)` }
      ],
      { duration: 300 + Math.random() * 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
    );
  }
}
