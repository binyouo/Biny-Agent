// 无障碍树的「给模型的形态」。
//
// 同样的 301 个元素，紧凑 JSON 要 40KB，而这个行集只要 12.7KB —— 观察一次省 14% 的
// 总载荷（其余大头是截图 base64）。参照实现给的也是行集：
//   [index] role "label" @x,y w×h (focused/disabled)
// 区别只在 ref：Alma 用位置序号，biny 一直用 element_token，所以两样都留着。
export interface ElementLike {
  element_token?: string; role?: string; title?: string; description?: string; value?: unknown;
  frame?: { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number };
  focused?: boolean; enabled?: boolean;
}
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
const label = (element: ElementLike): string => {
  const text = element.title ?? element.description ?? (typeof element.value === "string" ? element.value : "");
  return text ? ` ${JSON.stringify(text.slice(0, 40))}` : "";
};
export function renderElementTree(elements: readonly ElementLike[] | undefined): string {
  if (!elements?.length) return "";
  return elements.map((element, index) => {
    const frame = element.frame ?? {};
    const ref = element.element_token ? `(${element.element_token}) ` : "";
    // focused/disabled 内联在行尾：模型扫一眼就知道输入会落到哪个控件上。
    const flags = [element.focused ? "focused" : "", element.enabled === false ? "disabled" : ""].filter(Boolean).join(",");
    const size = `${number(frame.w ?? frame.width)}×${number(frame.h ?? frame.height)}`;
    return `[${index}] ${ref}${element.role ?? "AXUnknown"}${label(element)} @${number(frame.x)},${number(frame.y)} ${size}${flags ? ` (${flags})` : ""}`;
  }).join("\n");
}
