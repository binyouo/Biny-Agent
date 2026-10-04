import { z } from "zod";

/** App menu roots can leak into window AX walks. Keep only the selected window tree. */
export function scopeWindowObservation(data: Record<string, unknown>): Record<string, unknown> {
  const element = z.object({ element_index: z.number().int(), parent_index: z.number().int().optional(), depth: z.number().int().optional(), role: z.string() }).passthrough();
  const elements = z.array(element).parse(data.elements);
  const roots = elements.filter(item => item.role === "AXWindow" && item.depth === 0 && item.parent_index === undefined);
  if (roots.length !== 1) throw new Error("computer_window_scope_unavailable: exact window AX root required");
  const admitted = new Set([roots[0]!.element_index]);
  for (let pass = 0; pass < elements.length; pass++) {
    const before = admitted.size;
    for (const item of elements) if (item.parent_index !== undefined && admitted.has(item.parent_index)) admitted.add(item.element_index);
    if (admitted.size === before) break;
  }
  const scoped = elements.filter(item => admitted.has(item.element_index));
  const result: Record<string, unknown> = {};
  // No raw/markdown duplicates, notes or global application/menu metadata cross this boundary.
  for (const key of ["pid", "window_id", "capture_id", "snapshot_id", "screenshot_width", "screenshot_height", "screenshot_frame_valid"]) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  return { ...result, element_count: scoped.length, elements: scoped };
}
