/** 在同一个 SVG root 中更新图表；稳定节点从旧几何位置过渡到新布局。 */
const DURATION_MS = 200;
const EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const activeMorphs = new WeakMap<SVGSVGElement, () => void>();

function keyOf(element: Element, occurrences: Map<string, number>): string {
  const parts = [element.tagName, element.getAttribute("class") ?? ""];
  let semantic = false;
  for (const attribute of ["data-id", "data-from", "data-to", "data-label", "data-actor", "data-entity1", "data-entity2"]) {
    const value = element.getAttribute(attribute);
    if (value !== null) { semantic = true; parts.push(`${attribute}=${value}`); }
  }
  if (!semantic) parts.push("#anon");
  const base = parts.join("|");
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return `${base}|${occurrence}`;
}

function numbers(attribute: string | null): number[] | undefined {
  if (!attribute) return undefined;
  const values = attribute.trim().split(/[\s,]+/u).map(Number);
  return values.length >= 4 && values.every(Number.isFinite) ? values : undefined;
}

export function cancelDiagramMorph(host: HTMLElement): void {
  const svg = host.querySelector("svg");
  if (svg) activeMorphs.get(svg)?.();
}

export function updateDiagramSvg(host: HTMLElement, svg: string): void {
  const current = host.querySelector("svg");
  if (!current) { host.innerHTML = svg; return; }
  activeMorphs.get(current)?.();
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (parsed.localName !== "svg") return;
  const previous = new Map<string, { x: number; y: number; points?: number[] }>();
  const occurrences = new Map<string, number>();
  for (const child of Array.from(current.children)) {
    if (child.localName === "style" || child.localName === "defs") continue;
    const key = keyOf(child, occurrences);
    try {
      const box = (child as SVGGraphicsElement).getBBox();
      previous.set(key, { x: box.x + box.width / 2, y: box.y + box.height / 2, points: numbers(child.getAttribute("points")) });
    } catch { /* 无几何接口的环境直接更新静态输出。 */ }
  }
  const oldViewBox = numbers(current.getAttribute("viewBox"));
  const newViewBox = numbers(parsed.getAttribute("viewBox"));
  const oldWidth = parseFloat(current.getAttribute("width") ?? "");
  const oldHeight = parseFloat(current.getAttribute("height") ?? "");
  const width = parseFloat(parsed.getAttribute("width") ?? "");
  const height = parseFloat(parsed.getAttribute("height") ?? "");
  const view = host.ownerDocument.defaultView;
  const animated = previous.size > 0 && oldViewBox?.length === 4 && newViewBox?.length === 4 && [oldWidth, oldHeight, width, height].every(Number.isFinite)
    && typeof current.animate === "function" && !!view?.requestAnimationFrame && !view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const attribute of Array.from(current.attributes)) if (!parsed.hasAttribute(attribute.name)) current.removeAttributeNode(attribute);
  for (const attribute of Array.from(parsed.attributes)) current.setAttribute(attribute.name, attribute.value);
  current.replaceChildren(...Array.from(parsed.children).map(child => document.importNode(child, true)));
  if (!animated || !oldViewBox || !newViewBox || !view) return;
  const animations: Animation[] = [];
  const edges: { element: Element; from: number[]; to: number[] }[] = [];
  occurrences.clear();
  for (const child of Array.from(current.children)) {
    if (child.localName === "style" || child.localName === "defs") continue;
    const old = previous.get(keyOf(child, occurrences));
    if (!old) { animations.push(child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS, easing: EASING })); continue; }
    const points = numbers(child.getAttribute("points"));
    if (old.points && points && old.points.length === points.length) {
      if (old.points.some((value, index) => value !== points[index])) edges.push({ element: child, from: old.points, to: points });
      continue;
    }
    try {
      const box = (child as SVGGraphicsElement).getBBox();
      const x = old.x - box.x - box.width / 2;
      const y = old.y - box.y - box.height / 2;
      if (Math.abs(x) > .5 || Math.abs(y) > .5) animations.push(child.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], { duration: DURATION_MS, easing: EASING }));
    } catch { /* 不可测量节点保持新布局。 */ }
  }
  let frame = 0;
  const start = view.performance.now();
  const pointsAttribute = (values: number[]) => values.reduce((text, value, index) => `${text}${index ? index % 2 ? "," : " " : ""}${value}`, "");
  const final = () => {
    current.setAttribute("viewBox", newViewBox.join(" "));
    current.setAttribute("width", String(width));
    current.setAttribute("height", String(height));
    for (const edge of edges) edge.element.setAttribute("points", pointsAttribute(edge.to));
  };
  const tick = (now: number) => {
    const elapsed = Math.min(1, (now - start) / DURATION_MS);
    const progress = 1 - (1 - elapsed) ** 3;
    current.setAttribute("viewBox", oldViewBox.map((value, index) => value + (newViewBox[index]! - value) * progress).join(" "));
    current.setAttribute("width", String(oldWidth + (width - oldWidth) * progress));
    current.setAttribute("height", String(oldHeight + (height - oldHeight) * progress));
    for (const edge of edges) edge.element.setAttribute("points", pointsAttribute(edge.from.map((value, index) => value + (edge.to[index]! - value) * progress)));
    if (elapsed < 1) frame = view.requestAnimationFrame(tick);
    else { final(); activeMorphs.delete(current); }
  };
  frame = view.requestAnimationFrame(tick);
  activeMorphs.set(current, () => { view.cancelAnimationFrame(frame); for (const animation of animations) animation.cancel(); final(); activeMorphs.delete(current); });
}
