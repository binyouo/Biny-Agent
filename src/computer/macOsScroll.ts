/** Adapt content directions only for the fixed release's targeted web wheel route. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ComputerAction, WindowTarget } from "./protocol.js";
import type { DriverReply } from "./controller.js";

const execute = promisify(execFile);
type Direction = NonNullable<ComputerAction["direction"]>;
export interface ScrollObservation {
  session: string; target: WindowTarget; captureId: string; snapshotId: string; capturedAt: number;
  elements: ReadonlyArray<{ token: string; role: string; web: boolean }>;
}
export interface ScrollPlan { args?: Record<string, unknown>; refusal?: DriverReply; mapped?: boolean }
const opposite: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
export function parseNaturalScrolling(value: string): boolean | undefined {
  const setting = value.trim(); return setting === "1" ? true : setting === "0" ? false : undefined;
}
export async function readMacOsNaturalScrolling(signal: AbortSignal): Promise<boolean | undefined> {
  try {
    const result = await execute("/usr/bin/defaults", ["read", "-g", "com.apple.swipescrolldirection"], { signal, timeout: 2_000, maxBuffer: 128 });
    return parseNaturalScrolling(result.stdout);
  } catch { return undefined; }
}
export function scrollObservationFromReply(session: string, data: Record<string, unknown>, now: number): ScrollObservation | undefined {
  const parsed = z.object({ pid: z.number().int().positive(), window_id: z.number().int().safe().positive(), capture_id: z.string().min(1), snapshot_id: z.string().min(1), elements: z.array(z.object({ element_token: z.string().optional(), role: z.string().optional(), in_web_content: z.boolean().optional() }).passthrough()).max(200) }).passthrough().safeParse(data);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return { session, target: { pid: value.pid, windowId: String(value.window_id) }, captureId: value.capture_id, snapshotId: value.snapshot_id, capturedAt: now, elements: value.elements.flatMap(element => element.element_token ? [{ token: element.element_token, role: element.role ?? "", web: element.in_web_content === true }] : []) };
}
export function planMacOsScroll(session: string, action: ComputerAction, observation: ScrollObservation | undefined, naturalScrolling: boolean | undefined, now: number): ScrollPlan {
  const refuse = (code: string, reason: string): ScrollPlan => ({ refusal: { data: { effect: "refused", dispatched: false, reason }, images: [], errorCode: code } });
  if (!observation || observation.session !== session || observation.captureId !== action.captureId || observation.target.pid !== action.pid || observation.target.windowId !== action.windowId) return refuse("capture_target_mismatch_or_missing", "Observe this exact window again before scrolling.");
  if (now - observation.capturedAt >= 60_000) return refuse("capture_expired", "Observe again; the scroll frame expired.");
  const element = observation.elements.find(element => element.token === action.elementToken);
  if (!element) return refuse("element_token_not_in_observation", "The scroll target must belong to the fresh Cua observation.");
  // The release first attempts native AX text-area scrolling, then may fall back to a wheel.
  // Only a web target outside AXTextArea proves the wheel route before dispatch.
  if (!element.web || element.role === "AXTextArea") return refuse("scroll_route_unverified", "macOS scrolling is currently supported only for observed web scroll regions; scroll this native control manually and observe again.");
  if (!action.direction || action.amount !== undefined && (!Number.isInteger(action.amount) || action.amount < 1 || action.amount > 10)) return refuse("invalid_scroll_amount_or_direction", "Scroll requires a direction and 1–10 line notches; zero is rejected before dispatch.");
  if (naturalScrolling === undefined) return refuse("scroll_direction_setting_unavailable", "Cannot read the natural-scrolling direction; no input dispatched. Check the setting and observe again.");
  const windowId = Number(action.windowId);
  if (!Number.isSafeInteger(windowId)) return refuse("window_id_not_json_safe", "This release refuses lossy generic window ID encoding.");
  // A supported background web wheel has the same device-direction conversion.
  // Electron refusal still comes from the official background path; never retry foreground.
  const mapped = naturalScrolling;
  return { mapped, args: { session, pid: action.pid, window_id: windowId, snapshot_id: observation.snapshotId, element_token: action.elementToken, delivery_mode: action.delivery, direction: mapped ? opposite[action.direction] : action.direction, by: "line", amount: action.amount ?? 1 } };
}
