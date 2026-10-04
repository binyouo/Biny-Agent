import net from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserAutomationEndpoint } from "./browser.js";
import { ToolAccesses } from "./access.js";
import { ToolOutcomeUnknownError, type Tool, type ToolExecutionContext } from "./types.js";
import { computerActionSchema, computerImageSchema, windowTargetSchema } from "../computer/protocol.js";
import type { DriverReply } from "../computer/controller.js";

const commonProperties = { pid: { type: "integer" as const, minimum: 1 }, windowId: { type: "string" as const, pattern: "^[1-9][0-9]{0,19}$", description: "Exact window ID from ComputerList; preserve as decimal string." } };
export function createComputerUseTools(endpoint: BrowserAutomationEndpoint): Tool[] {
  return [
    {
      name: "ComputerList", description: "List native apps, or exact windows of a pid. Requires user-enabled desktop control in Biny settings. Browser tasks should prefer Browser/ChromeRelay tools.", risk: "read", capability: "computer.list",
      parameters: { type: "object", properties: { pid: commonProperties.pid }, additionalProperties: false }, schema: z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict(),
      resolveExecution: args => execution(endpoint, "list", z.object({ pid: windowTargetSchema.shape.pid.optional() }).strict().parse(args), false)
    },
    {
      name: "ComputerObserve", description: "Observe one exact native window using Cua, returning an image, fresh capture_id and element tokens. This screenshot is sent to the current model only after the execution service checks the target application approval; it is not saved to Activity memory.", risk: "read", capability: "computer.observe",
      parameters: { type: "object", properties: commonProperties, required: ["pid", "windowId"], additionalProperties: false }, schema: windowTargetSchema,
      resolveExecution: args => execution(endpoint, "observe", windowTargetSchema.parse(args), false)
    },
    {
      name: "ComputerAction", description: "Perform one action on an approved application and exact observed window and return a fresh verification image. Coordinates must be from capture_id. Background is default; refusals never retry foreground. Foreground delivery needs user enablement and approval. Unverified delivery is not success.", risk: "execute", capability: "computer.action",
      promptGuidelines: ["If application approval is required, ask the user to approve the app in Settings → Computer Use. Global tool approval does not override strict application approval.", "Use ComputerList, then ComputerObserve to choose an exact target; never guess IDs or element tokens.", "On stale capture or background refusal, re-observe or ask the user to switch foreground. Never replay an unknown action.", "Scroll directions describe content navigation (up decreases vertical offset; right increases horizontal offset). Amount is 1–10 line-wheel notches, default 1, not CSS pixels. macOS currently supports observed web regions; native AX controls are refused.", "The preview updates after observations/actions, not continuously. Check the intended UI postcondition in the returned frame."],
      parameters: { type: "object", properties: { ...commonProperties, action: { type: "string", enum: ["click", "type_text", "press_key", "scroll"] }, captureId: { type: "string" }, delivery: { type: "string", enum: ["background", "foreground"] }, x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, text: { type: "string", maxLength: 4000 }, key: { type: "string", maxLength: 40 }, elementToken: { type: "string" }, direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Content navigation: up/left decrease the corresponding scroll offset; down/right increase it." }, amount: { type: "integer", minimum: 1, maximum: 10, description: "Line-wheel notches, default 1. Not CSS pixels. Zero is rejected before dispatch." } }, required: ["pid", "windowId", "action", "captureId"], additionalProperties: false }, schema: computerActionSchema,
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
      const image = error ? undefined : reply.images[0];
      const imageReturned = image ? context.onImage?.({ type: "image", mimeType: image.mimeType, data: image.dataBase64 }) === true : false;
      return { ...reply.data, error, imageReturned, ...(reply.images.length && !imageReturned ? { observationImageUnavailable: true, doNotRepeat: mutation } : {}) };
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
