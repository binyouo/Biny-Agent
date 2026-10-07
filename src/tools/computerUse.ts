import net from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserAutomationEndpoint } from "./browser.js";
import { ToolAccesses } from "./access.js";
import { ToolOutcomeUnknownError, type Tool, type ToolExecutionContext } from "./types.js";
import { computerActionSchema, computerImageSchema, computerMirrorSchema, windowObserveSchema, windowTargetSchema } from "../computer/protocol.js";
import type { DriverReply } from "../computer/controller.js";
import { renderElementTree, type ElementLike } from "../computer/elementTree.js";

const commonProperties = { pid: { type: "integer" as const, minimum: 1 }, windowId: { type: "string" as const, pattern: "^[1-9][0-9]{0,19}$", description: "Exact window ID from ComputerList; preserve as decimal string." } };
export function createComputerUseTools(endpoint: BrowserAutomationEndpoint): Tool[] {
  return [
    {
      name: "ComputerMirror", description: "Open a live mirror of an approved native window without raising the application. Choose an exact pid/windowId from ComputerList. onMinimize arms presentation when the user minimizes the window. List mirrors and frame age, or close this session's mirrors. Does not restore or activate the source window.", risk: "execute", capability: "computer.mirror",
      parameters: { type: "object", properties: { operation: { type: "string", enum: ["open", "close", "list"] }, ...commonProperties, onMinimize: { type: "boolean" }, all: { type: "boolean" } }, required: ["operation"], additionalProperties: false }, schema: computerMirrorSchema,
      resolveExecution: args => execution(endpoint, "mirror", computerMirrorSchema.parse(args), true)
    },
    {
      name: "ComputerList", description: "List native apps, or exact windows of a pid. Requires user-enabled desktop control in Biny settings. Browser tasks should prefer Browser/ChromeRelay tools.", risk: "read", capability: "computer.list",
      parameters: { type: "object", properties: { pid: commonProperties.pid }, additionalProperties: false }, schema: z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict(),
      resolveExecution: args => execution(endpoint, "list", z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict().parse(args), false)
    },
    {
      name: "ComputerObserve", description: "Observe one exact native window, returning an image, fresh capture_id and element tokens. This screenshot is sent to the current model only after the execution service checks the target application approval; it is not saved to Activity memory.", risk: "read", capability: "computer.observe",
      parameters: { type: "object", properties: { ...commonProperties,
        depth: { type: "integer", minimum: 1, maximum: 20, description: "AX tree depth, from 1 to 20." },
        screenshotMaxWidth: { type: "integer", minimum: 1, description: "Downsample width of the screenshot, default 1280." },
        interactiveOnly: { type: "boolean", description: "Limit the element list to interactive elements. Default true; set false for the full tree." },
        autoLaunch: { type: "boolean", description: "Launch the app in the background if it is not running. Default true." },
      }, required: ["pid", "windowId"], additionalProperties: false }, schema: windowObserveSchema,
      resolveExecution: args => execution(endpoint, "observe", windowObserveSchema.parse(args), false)
    },
    {
      name: "ComputerAction", description: "Perform one action on an approved application and exact observed window and return a fresh verification image. Coordinates must be from capture_id. Background is default; refusals never retry foreground. Foreground delivery needs user enablement and approval. Unverified delivery is not success.", risk: "execute", capability: "computer.action",
      promptGuidelines: [
        "Use ComputerList, then ComputerObserve to choose an exact target; never guess IDs, element tokens or screenshot coordinates. Prefer a usable element token; custom-drawn controls without tokens require screenshot coordinates.",
        "type_text with auto, physical or unicode may omit elementToken and uses the target's keyboard focus. Only inputMethod=ax requires a writable elementToken. Click the field first, inspect the returned observation for focus, then type with its fresh capture_id.",
        "If application approval is required, ask the user to approve the app in Settings → Computer Use. Global tool approval does not override strict application approval.",
        "Background is default. Observations report foregroundAllowed. Use delivery=foreground only when that permission is true and foreground delivery is intentionally selected. Otherwise ask the user to enable it in Settings → Computer Use. Never silently upgrade a failed background action or replay unknown input; re-observe and inspect what remains first.",
        "An unverified action is not success. Inspect its returned verification image and fresh capture_id to determine the next distinct step; do not repeat the action just because it is marked as an error. If the image is unavailable or the outcome is unknown, observe again before any further input.",
        "Scroll directions describe content navigation (up decreases vertical offset; right increases horizontal offset). Amount is in pages, default 1. Native scroll areas use measured scrollbar ratios; web content uses estimated wheel notches. Check the reply's unit field if the distance matters.",
        "The live preview is for supervision; its frames do not refresh capture_id or element tokens. Verify the requested UI postcondition, not merely a changed picture."
      ],
      parameters: { type: "object", properties: { ...commonProperties, action: { type: "string", enum: ["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"], description: "click/type_text/press_key/scroll are the common four. drag moves the mouse between two screenshot points. perform_secondary_action opens the element context menu. set_value writes an accessibility value directly (sliders, steppers, fields) without keystrokes. select_text selects a run of text, or places the cursor when only location is given." }, captureId: { type: "string" }, delivery: { type: "string", enum: ["background", "foreground"] },
        button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 }, strategy: { type: "string", enum: ["auto", "physical", "ax"] }, coordinateSpace: { type: "string", enum: ["screenshot", "screen"] }, showCursor: { type: "boolean", description: "Set false to hide the action indicator for this one action." },
        inputMethod: { type: "string", enum: ["auto", "physical", "unicode", "ax"], description: "How to deliver text: physical uses the selected keyboard layout and rejects unrepresentable text before input; auto chooses writable AX with a ref, then a complete physical key plan, then Unicode; unicode uses keyboard focus; ax writes the element directly." }, x: { type: "number" }, y: { type: "number" }, text: { type: "string", maxLength: 4000 }, key: { type: "string", maxLength: 40 }, elementToken: { type: "string" }, direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Content navigation: up/left decrease the corresponding scroll offset; down/right increase it." }, pages: { type: "integer", minimum: 1, maximum: 20, description: "How many pages to scroll, default 1. A page is the viewport, measured from the scroll area rather than guessed; the reply says whether it was measured or estimated. Zero is rejected before dispatch." },
        x1: { type: "number", description: "drag: start point in screenshot pixels." }, y1: { type: "number" },
        x2: { type: "number", description: "drag: end point in screenshot pixels." }, y2: { type: "number" },
        value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }], description: "set_value: the value to write, matching the control's own type." },
        location: { type: "integer", minimum: 0, description: "select_text: character offset to place the cursor at when no text is given." },
        length: { type: "integer", minimum: 0, description: "select_text: characters to select from location. Default 0 (cursor only)." } }, required: ["pid", "windowId", "action", "captureId"], additionalProperties: false }, schema: computerActionSchema,
      resolveExecution: args => execution(endpoint, "action", computerActionSchema.parse(args), true)
    }
  ];
}
function execution(endpoint: BrowserAutomationEndpoint, method: string, args: Record<string, unknown>, mutation: boolean) {
  return {
    accesses: ToolAccesses.browser("biny:single-desktop"), retrySafety: mutation ? "unsafe" as const : "safe" as const,
    approvalRule: `computer_${method}`,
    description: `Computer ${typeof args.action === "string" ? args.action : method} · pid ${String(args.pid ?? "apps")} · window ${String(args.windowId ?? "list")} · ${String(args.delivery ?? "background")}`,
    display: { kind: "generic" as const, summary: `Computer ${method}`, detail: { ...args, text: args.text === undefined ? undefined : "[input hidden]" } },
    async execute(context: ToolExecutionContext): Promise<unknown> {
      if (!context.sessionId) throw new Error("Computer use requires an Agent session.");
      const reply = await requestComputer(endpoint, method, { ...args, session: context.sessionId }, context.signal, mutation, () => { context.onDispatched?.(); context.onExecutionState?.("admitted", "Desktop request dispatched."); });
      const error = reply.errorCode ?? (reply.data.status === "unverified" ? "action_unverified: delivery may have occurred. Do not repeat; obtain a fresh observation and inspect the target." : undefined);
      // The generic tool UI must not label unverified/partial input as successful.
      const image = reply.errorCode ? undefined : reply.images[0];
      const imageReturned = image ? context.onImage?.({ type: "image", mimeType: image.mimeType, data: image.dataBase64 }) === true : false;
      // 无障碍树按行集交给模型：同样 301 个元素，紧凑 JSON 要 40KB，行集只要 12.7KB，
      // 而观察是要反复做的。element_token 留在行首括号里，动作仍按 token 引用。
      const { elements, ...rest } = reply.data as { elements?: ElementLike[] } & Record<string, unknown>;
      const tree = renderElementTree(elements);
      return { ...rest, ...(tree ? { tree } : {}), error, imageReturned, ...(reply.images.length && !imageReturned ? { observationImageUnavailable: true, doNotRepeat: mutation } : {}) };
    }
  };
}
export async function requestComputer(endpoint: BrowserAutomationEndpoint, method: string, args: Record<string, unknown>, signal?: AbortSignal, mutation = false, onDispatched?: () => void): Promise<DriverReply> {
  signal?.throwIfAborted();
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.endpoint);
    let buffer = ""; let settled = false; let dispatched = false;
    const finish = (error?: Error, reply?: DriverReply): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    const lost = (reason: string): void => finish(dispatched && mutation ? new ToolOutcomeUnknownError("transport_error", `Computer outcome unknown: ${reason}`) : new Error(reason));
    const abort = (): void => lost("Desktop call cancelled");
    const timer = setTimeout(() => lost("Desktop call timed out"), 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8"); socket.once("error", error => lost(error.message)); socket.once("close", () => { if (!settled) lost("Desktop disconnected"); });
    socket.once("connect", () => { if (settled || signal?.aborted) return; dispatched = true; onDispatched?.(); socket.write(`${JSON.stringify({ id, token: endpoint.token, method: `computer_${method}`, args })}\n`); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { lost("Desktop response exceeds frame budget"); return; }
      const end = buffer.indexOf("\n"); if (end < 0) return;
      try {
        const response = z.object({ id: z.literal(id), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional(), outcomeUnknown: z.boolean().optional() }).parse(JSON.parse(buffer.slice(0, end)));
        if (!response.ok) { if (response.outcomeUnknown) finish(new ToolOutcomeUnknownError("interrupted", response.error ?? "Computer outcome unknown")); else finish(new Error(response.error ?? "Desktop call refused")); return; }
        const reply = z.object({ data: z.record(z.unknown()), images: z.array(computerImageSchema).max(1), errorCode: z.string().optional() }).parse(response.result);
        finish(undefined, reply);
      } catch { lost("Invalid Desktop response"); }
    });
  });
}
