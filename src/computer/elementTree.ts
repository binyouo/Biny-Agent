// 用紧凑行集向模型呈现控件引用、语义状态、位置与可用动作。
export interface ElementLike {
  /** 面向调用方的引用（有截图那条路给的）。 */
  element_token?: string;
  /** daemon 原样返回的引用（`--no-shot` 那条路给的，没有经过 shape 映射）。
   *  两种都要认 —— 否则 `snap --no-shot` 出来的行集没有 ref，**点了没用**。 */
  ref?: string; role?: string; subrole?: string; title?: string; description?: string; role_description?: string; value?: unknown;
  frame?: { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number };
  focused?: boolean; enabled?: boolean; selected?: boolean; actions?: string[]; children_count?: number;
}

/** 外部客户端使用 ref 和 bounds；内部捕获使用 element_token 和 frame。 */
export function externalElements(elements: readonly ElementLike[] | undefined): Record<string, unknown>[] {
  return (elements ?? []).map(element => {
    const { element_token, ref, frame, ...rest } = element;
    const bounds = frame && Object.fromEntries(Object.entries({ x: frame.x, y: frame.y, w: frame.w ?? frame.width, h: frame.h ?? frame.height }).filter(([, value]) => value !== undefined));
    return Object.fromEntries(Object.entries({
      ...rest,
      ref: element_token ?? ref,
      bounds
    }).filter(([, value]) => value !== undefined));
  });
}
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
const label = (element: ElementLike): string | undefined => [element.title, element.description, element.value, element.role_description]
  .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
export function renderElementTree(elements: readonly ElementLike[] | undefined): string {
  if (!elements?.length) return "";
  return elements.map((element, index) => {
    const frame = element.frame;
    const token = element.element_token ?? element.ref;
    const ref = token ? `(${token}) ` : "";
    // 将焦点、禁用和选中状态保留在同一行。
    const flags = [element.focused ? "focused" : "", element.enabled === false ? "disabled" : "", element.selected === true ? "selected" : element.selected === false ? "unselected" : ""].filter(Boolean).join(",");
    const position = frame ? ` @${number(frame.x)},${number(frame.y)} ${number(frame.w ?? frame.width)}x${number(frame.h ?? frame.height)}` : "";
    const text = label(element);
    const value = typeof element.value === "string" && element.value.trim() && element.value.trim() !== text ? ` value=${JSON.stringify(element.value)}` : "";
    const subrole = element.subrole ? ` subrole=${JSON.stringify(element.subrole)}` : "";
    const actions = element.actions?.length ? ` actions=${JSON.stringify(element.actions)}` : "";
    return `[${index}] ${ref}${element.role ?? "AXUnknown"}${text ? ` ${JSON.stringify(text)}` : ""}${value}${subrole}${position}${flags ? ` (${flags})` : ""}${actions}`;
  }).join("\n");
}
