import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { applicationPlaybook } from "./playbooks.js";

type Extra = Parameters<ToolCallback<z.ZodRawShape>>[1];
export type SkyDispatchOptions = { deferActionScreenshot?: boolean };
type Dispatch = (name: string, args: Record<string, unknown>, extra: Extra, options?: SkyDispatchOptions) => Promise<CallToolResult>;
const app = z.string().min(1).max(256);
const index = z.number().int().nonnegative().safe();
const coordinate = z.number().finite();
const text = (result: CallToolResult): string => result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const incompleteObservation = (warning: unknown): boolean => typeof warning === "string" && /^(accessibility_timeout|accessibility_window_unavailable|accessibility_tree_incomplete|empty_after_wakeup):/u.test(warning);
function receipt(result: CallToolResult): Record<string, unknown> | undefined {
  const part = result.content.find(item => item.type === "text");
  if (!part || part.type !== "text") return undefined;
  for (const candidate of [part.text, part.text.split("\n", 1)[0]!]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 回执后可附控件树 */ }
  }
  return undefined;
}
function withObservationRequired(result: CallToolResult, required: boolean): CallToolResult {
  const content = result.content.map(part => {
    if (part.type !== "text") return part;
    const newline = part.text.indexOf("\n");
    for (const prefix of [part.text, newline < 0 ? "" : part.text.slice(0, newline)]) {
      try {
        const parsed: unknown = JSON.parse(prefix);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const suffix = part.text.slice(prefix.length);
        return { ...part, text: JSON.stringify({ ...parsed, observationRequired: required }) + (/^\n\[0\] \(/u.test(suffix) ? "" : suffix) };
      } catch { /* 非 JSON 内容不需要改写 */ }
    }
    return part;
  });
  const { postShotDeferred: _deferred, ...structured } = result.structuredContent ?? {};
  return { ...result, structuredContent: { ...receipt(result), ...structured, observationRequired: required }, content };
}

type ListedApp = { pid?: number; bundleId?: string; name?: string; running?: boolean; lastUsed?: string; useCount?: number };
export function registerSkyComputerTools(server: McpServer, dispatch: Dispatch, generation: () => number): void {
  let current: { app: string; bundle: string; pid: number; windowId: number; refs: Map<number, string>; revision: number } | undefined;
  let observationRequest = 0;
  const history = new Map<string, { entries: Map<string, { index: number; line: string }>; nextIndex: number; at: number }>();
  const sentPlaybooks = new Set<string>();
  async function list(extra: Extra): Promise<{ apps?: ListedApp[]; error?: CallToolResult }> {
    const result = await dispatch("list_apps", {}, extra);
    if (result.isError) return { error: result };
    try {
      const value: unknown = JSON.parse(text(result));
      const parsed = z.object({ apps: z.array(z.object({ pid: z.number().optional(), bundleId: z.string().optional(), name: z.string().optional(), running: z.boolean().optional(), lastUsed: z.string().optional(), useCount: z.number().optional() }).passthrough()) }).passthrough().parse(value);
      return { apps: parsed.apps };
    } catch { return { error: failure("computer_app_list_invalid") }; }
  }
  async function resolveApp(value: string, extra: Extra): Promise<{ bundle?: string; error?: CallToolResult }> {
    const listed = await list(extra);
    if (listed.error) return { error: listed.error };
    const exact = listed.apps!.filter(item => item.bundleId === value);
    if (exact.length) return { bundle: value };
    const matches = listed.apps!.filter(item => item.name === value && item.bundleId);
    const bundles = [...new Set(matches.map(item => item.bundleId!))];
    if (bundles.length > 1) return { error: failure("computer_app_identity_unavailable: specify an application ID") };
    return { bundle: bundles[0] ?? value };
  }
  const register = <Shape extends z.ZodRawShape>(name: string, shape: Shape, description: string, callback: ToolCallback<Shape>): void => {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(name, { description, inputSchema: schema }, callback as ToolCallback<typeof schema>);
  };
  register("sky_list_apps", {}, "List applications with IDs, names and running status.", async (_args, extra) => {
    const listed = await list(extra);
    if (listed.error) return listed.error;
    return { content: [{ type: "text", text: JSON.stringify(listed.apps!.map(item => ({ id: item.bundleId ?? item.name ?? "unknown", displayName: item.name, isRunning: item.running, lastUsedDate: item.lastUsed, useCount: item.useCount })), null, 2) }] };
  });
  register("sky_get_app_state", { app, disableDiff: z.boolean().optional(), window_id: z.number().int().positive().max(4294967295).optional() }, "Observe an application window and return a screenshot and numbered controls. Pass disableDiff for the full tree; specify window_id when the application has multiple windows.", async (args, extra) => {
    const request = ++observationRequest;
    const initialRevision = generation();
    current = undefined;
    const resolved = await resolveApp(args.app, extra);
    if (resolved.error) return resolved.error;
    if (request !== observationRequest || initialRevision !== generation()) return failure("computer_observation_invalidated: observe the target again");
    const pending = dispatch("get_app_state", { bundle: resolved.bundle, window_id: args.window_id }, extra);
    const revision = generation();
    const observed = await pending;
    if (observed.isError) return observed;
    if (request !== observationRequest || revision !== generation()) return failure("computer_observation_invalidated: observe the target again");
    const refs = new Map<number, string>();
    const entries = new Map<string, { index: number; line: string }>();
    const metadata = observed.structuredContent;
    const pid = metadata?.pid;
    const windowId = metadata?.window_id ?? metadata?.windowId;
    const now = performance.now();
    for (const [key, item] of history) if (now - item.at >= 60_000) history.delete(key);
    const historyKey = typeof pid === "number" && (typeof windowId === "number" || typeof windowId === "string")
      ? JSON.stringify([resolved.bundle, pid, String(windowId)]) : undefined;
    const previous = args.disableDiff || historyKey === undefined ? undefined : history.get(historyKey);
    let nextIndex = previous?.nextIndex ?? 0;
    let unchanged = 0;
    const lines: string[] = [];
    for (const line of text(observed).split("\n")) {
      const match = /^\[(\d+)\] \(([^)]+)\) (.*)$/u.exec(line);
      if (!match) continue;
      const ref = match[2]!, old = previous?.entries.get(ref);
      const skyIndex = old?.index ?? nextIndex++;
      const rendered = `[${skyIndex}] ${match[3]!.replace(/^AX(?=\w)/u, "")}`;
      refs.set(skyIndex, ref); entries.set(ref, { index: skyIndex, line: rendered });
      if (old?.line === rendered) unchanged++; else lines.push(rendered);
    }
    const missing = previous ? [...previous.entries].filter(([ref]) => !entries.has(ref)).map(([, item]) => item.index) : [];
    const missingLabel = incompleteObservation(metadata?.warning) ? "unavailable indices" : "removed indices";
    const diff = previous ? `(diff: ${lines.length} changed, ${unchanged} unchanged${missing.length ? `, ${missingLabel}: ${missing.join(", ")}` : ""}. Pass disableDiff for the full tree.)` : "";
    const image = observed.content.find(part => part.type === "image");
    const diagnostics = [metadata?.warning, metadata?.screenshot_error].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (!image && diagnostics.length === 0) diagnostics.push("Screenshot unavailable; observe the window again before input.");
    const book = !sentPlaybooks.has(resolved.bundle!) ? applicationPlaybook(resolved.bundle) : "";
    if (book) sentPlaybooks.add(resolved.bundle!);
    if (image && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(Number(windowId)) && Number(windowId) > 0) {
      current = { app: args.app, bundle: resolved.bundle!, pid, windowId: Number(windowId), refs, revision };
      if (historyKey !== undefined) {
        history.delete(historyKey);
        if (history.size >= 64) history.delete(history.keys().next().value!);
        history.set(historyKey, { entries, nextIndex, at: now });
      }
    }
    const body = { app: args.app, screenshot: image?.type === "image" ? { url: `data:${image.mimeType};base64,${image.data}` } : null, text: [book, ...diagnostics, diff, lines.join("\n")].filter(Boolean).join("\n") };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }, ...(image ? [image] : [])] };
  });
  const invoke = async (requested: string, name: string, fields: Record<string, unknown>, extra: Extra, elementIndex?: number): Promise<CallToolResult> => {
    const observed = current;
    if (!observed || observed.app !== requested || observed.revision !== generation()) return failure("computer_observation_required: call sky_get_app_state for this application first");
    const request = observationRequest;
    if (elementIndex !== undefined) {
      const ref = observed.refs.get(elementIndex);
      if (!ref) return failure("element_index_not_observed: use an index from the latest observation");
      fields.ref = ref;
    }
    const before = generation();
    const pending = dispatch(name, { ...fields, bundle: observed.bundle }, extra, { deferActionScreenshot: true });
    if (generation() !== before) current = undefined;
    const revision = generation();
    const result = await pending;
    if (result.isError || (!result.content.some(part => part.type === "image") && result.structuredContent?.postShotDeferred !== true)) return result;
    const superseded = (): CallToolResult => {
      const corrected = withObservationRequired(result, true);
      corrected.content = corrected.content.filter(part => part.type !== "image");
      corrected.structuredContent = { ...corrected.structuredContent, doNotRepeat: true };
      corrected.content.push({ type: "text", text: "A newer operation superseded the action's observation. Use the latest observation before input; do not repeat the dispatched action automatically." });
      return corrected;
    };
    if (request !== observationRequest || revision !== generation()) return superseded();
    const unavailable = async (allowFallback = false): Promise<CallToolResult> => {
      const corrected = withObservationRequired(result, true);
      corrected.structuredContent = { ...corrected.structuredContent, doNotRepeat: true, observationRefreshFailed: true };
      corrected.content.push({ type: "text", text: "The action was already dispatched. A fresh observation could not be retained; observe again before the next input, and do not repeat this action automatically." });
      if (allowFallback && request === observationRequest && result.structuredContent?.postShotDeferred === true && !extra.signal.aborted) {
        try {
          const fallback = await dispatch("post_action_screenshot", { bundle: observed.bundle, pid: observed.pid, window_id: observed.windowId }, extra);
          const applicable = request === observationRequest && refreshRevision === generation();
          const image = !fallback.isError && applicable ? fallback.content.find(part => part.type === "image") : undefined;
          if (image) corrected.content.push(image);
          else if (applicable) {
            const reason = typeof fallback.structuredContent?.screenshot_error === "string" ? fallback.structuredContent.screenshot_error : text(fallback) || "post_action_screenshot_unavailable";
            corrected.structuredContent = { ...corrected.structuredContent, screenshot_error: reason };
            corrected.content.push({ type: "text", text: `Post-action screenshot unavailable: ${reason}` });
          }
        } catch { /* 纯截图不可用时保留动作回执 */ }
      }
      if (request !== observationRequest || refreshRevision !== generation()) corrected.content = corrected.content.filter(part => part.type !== "image");
      return corrected;
    };
    let next: CallToolResult;
    let refreshRevision: number;
    const actionReceipt = receipt(result);
    if (typeof actionReceipt?.capture_id === "string" && actionReceipt.capture_id.length > 0 && actionReceipt.observationRequired === false) {
      // Desktop 动作回执已包含完整的新观察和一次性凭据。
      next = result;
      refreshRevision = revision;
    } else {
      // 独立服务的动作截图不刷新凭据，需要另行观察。
      const refresh = dispatch("get_app_state", { bundle: observed.bundle, pid: observed.pid, window_id: observed.windowId, auto_launch: false }, extra);
      refreshRevision = generation();
      try { next = await refresh; } catch { return await unavailable(request === observationRequest && refreshRevision === generation()); }
    }
    if (request !== observationRequest) return await unavailable();
    const image = next.content.find(part => part.type === "image");
    const meta = next === result ? actionReceipt : next.structuredContent;
    const windowId = meta?.window_id ?? meta?.windowId;
    if (next.isError || !image) return await unavailable(refreshRevision === generation());
    if (refreshRevision !== generation() || meta?.pid !== observed.pid || Number(windowId) !== observed.windowId) {
      return await unavailable();
    }
    const available = new Set(text(next).split("\n").flatMap(line => /^\[\d+\] \(([^)]+)\) /u.exec(line)?.[1] ?? []));
    const refs = new Map([...observed.refs].filter(([, ref]) => available.has(ref)));
    const missing = [...observed.refs.keys()].filter(key => !refs.has(key));
    const warning = typeof meta?.warning === "string" ? meta.warning : undefined;
    const incomplete = incompleteObservation(warning);
    current = { ...observed, refs, revision: refreshRevision };
    const updated = withObservationRequired(result, false);
    updated.structuredContent = { ...updated.structuredContent, verificationRequired: true, doNotRepeat: true,
      observationWarning: warning, ...(incomplete ? { unavailableIndices: missing } : { removedIndices: missing }) };
    const content: CallToolResult["content"] = updated.content.filter(part => part.type !== "image");
    content.push({ type: "text", text: `Fresh observation captured. Existing indices remain valid only for the same elements${missing.length ? `; ${incomplete ? "unavailable" : "removed"} indices: ${missing.join(", ")}` : ""}.${warning ? ` ${warning}` : ""}` }, image);
    return { ...updated, content };
  };
  register("sky_click", { app, element_index: index.optional(), x: coordinate.optional(), y: coordinate.optional(), click_count: z.number().int().min(1).max(3).optional(), mouse_button: z.enum(["left", "right", "middle", "l", "r", "m"]).optional() }, "Click a numbered control or screenshot coordinates.", async (args, extra) => {
    if (args.element_index === undefined && (args.x === undefined || args.y === undefined)) return failure("sky_click requires element_index or x and y");
    const buttons = { l: "left", r: "right", m: "middle", left: "left", right: "right", middle: "middle" } as const;
    return await invoke(args.app, "click", { x: args.x, y: args.y, click_count: args.click_count, button: args.mouse_button ? buttons[args.mouse_button] : undefined }, extra, args.element_index);
  });
  register("sky_press_key", { app, key: z.string().min(1).max(40) }, "Press a key or chord in the observed window.", async (args, extra) => await invoke(args.app, "press_key", { key: args.key }, extra));
  register("sky_type_text", { app, text: z.string().max(4000) }, "Type into the observed window's focused control.", async (args, extra) => await invoke(args.app, "type_text", { text: args.text }, extra));
  register("sky_scroll", { app, element_index: index, direction: z.enum(["up", "down", "left", "right", "u", "d", "l", "r"]), pages: z.number().finite().positive().max(20).optional() }, "Scroll a numbered control.", async (args, extra) => {
    const directions = { u: "up", d: "down", l: "left", r: "right", up: "up", down: "down", left: "left", right: "right" } as const;
    return await invoke(args.app, "scroll", { direction: directions[args.direction], pages: args.pages }, extra, args.element_index);
  });
  register("sky_set_value", { app, element_index: index, value: z.string().max(4000) }, "Replace the value of a numbered control.", async (args, extra) => await invoke(args.app, "set_value", { value: args.value }, extra, args.element_index));
  register("sky_drag", { app, from_x: coordinate, from_y: coordinate, to_x: coordinate, to_y: coordinate }, "Drag between screenshot coordinates.", async (args, extra) => await invoke(args.app, "drag", { start_x: args.from_x, start_y: args.from_y, end_x: args.to_x, end_y: args.to_y }, extra));
  register("sky_perform_secondary_action", { app, element_index: index, action: z.string().min(1).max(256) }, "Perform an accessibility action on a numbered control.", async (args, extra) => await invoke(args.app, "perform_secondary_action", { secondary_action: args.action === "show_menu" ? "AXShowMenu" : args.action }, extra, args.element_index));
  register("sky_select_text", { app, element_index: index, text: z.string().min(1).max(4000), prefix: z.string().max(1000).optional(), suffix: z.string().max(1000).optional(), selection_type: z.enum(["text", "cursor_before", "cursor_after"]).optional() }, "Select matching text in a numbered control.", async (args, extra) => await invoke(args.app, "select_text", { text: args.text, prefix: args.prefix, suffix: args.suffix, selection_type: args.selection_type }, extra, args.element_index));
}
