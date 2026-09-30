/** Route-specific limits; an unverified native AX fallback must not be direction-inverted. */
import type { ComputerActionLimit } from "./protocol.js";

export function cuaActionLimits(platform: NodeJS.Platform, version: string): ComputerActionLimit[] {
  if (platform !== "darwin" || version !== "0.30.4") return [];
  return [{ action: "scroll", code: "scroll_route_unverified", message: "macOS 滚动仅支持新观察中的网页滚动区域。Electron 窗口不支持后台滚动，前台操作需明确批准；其他后台操作由驱动按目标判断。原生 AX 控件与未知目标暂不可用，会在派发前拒绝；请人工滚动后重新观察。" }];
}
