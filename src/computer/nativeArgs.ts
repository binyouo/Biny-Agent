import type { z } from "zod";
import type { computerActionPayload, computerObservationOptions, WindowTarget } from "./protocol.js";

type Payload = z.infer<typeof computerActionPayload>;
type Observation = z.infer<typeof computerObservationOptions>;

export function toNativeObservationArgs(target: Observation & Partial<WindowTarget>): Record<string, unknown> {
  return {
    pid: target.pid, window_id: target.windowId === undefined ? undefined : Number(target.windowId),
    max_elements: target.maxElements, max_depth: target.content === "image" ? 0 : target.depth,
    max_width: target.screenshotMaxWidth, interactive_only: target.interactiveOnly
  };
}

export function toNativeActionArgs(action: Payload & Partial<WindowTarget>): Record<string, unknown> {
  const common = {
    pid: action.pid, window_id: action.windowId === undefined ? undefined : Number(action.windowId),
    show_cursor: action.showCursor, coord_space: action.coordinateSpace
  };
  switch (action.action) {
    case "click": return { ...common, ref: action.elementToken, x: action.x, y: action.y, button: action.button, clicks: action.clickCount, strategy: action.strategy };
    case "type_text": return { ...common, text: action.text, input_method: action.inputMethod, ref: action.elementToken };
    case "press_key": return { ...common, key: action.key };
    case "scroll": return { ...common, ref: action.elementToken, x: action.x, y: action.y, direction: action.direction, pages: action.pages ?? 1 };
    case "drag": return { ...common, x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2 };
    case "perform_secondary_action": return { ...common, ...(action.elementToken ? { ref: action.elementToken } : { x: action.x, y: action.y }) };
    case "set_value": return { ...common, ref: action.elementToken, value: action.value };
    case "select_text": return { ...common, ref: action.elementToken, ...(action.matchText !== undefined
      ? { match_text: action.matchText, prefix: action.prefix, suffix: action.suffix }
      : action.text !== undefined ? { text: action.text } : { location: action.location, length: action.length ?? 0 }) };
  }
}
