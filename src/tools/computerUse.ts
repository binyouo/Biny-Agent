import net from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserAutomationEndpoint } from "./browser.js";
import { ToolAccesses } from "./access.js";
import { ToolOutcomeUnknownError, type Tool, type ToolExecutionContext } from "./types.js";
import { computerListSchema, computerActionSchema, computerImageSchema, computerMirrorSchema, windowObserveSchema } from "../computer/protocol.js";
import type { DriverReply } from "../computer/controller.js";
import { renderElementTree, type ElementLike } from "../computer/elementTree.js";

const commonProperties = { pid: { type: "integer" as const, minimum: 1 }, windowId: { type: "string" as const, pattern: "^[1-9][0-9]{0,19}$", description: "Exact window ID from ComputerList; preserve as decimal string." } };
export type ComputerToolCaller = (method: string, args: Record<string, unknown>, context: ToolExecutionContext, mutation: boolean) => Promise<DriverReply>;
export function createComputerUseTools(call: ComputerToolCaller): Tool[] {
  const tools: Tool[] = [
    {
      name: "ComputerLaunch", description: "按应用标识后台启动已获批准的本机应用；已运行时返回现有进程。启动后用 ComputerList 查询窗口，再观察准确窗口。系统接受启动不保证应用自身不会改变焦点。", risk: "execute", capability: "computer.launch",
      parameters: { type: "object", properties: { bundleId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["bundleId"], additionalProperties: false },
      schema: z.object({ bundleId: z.string().min(1).max(256) }).strict(),
      resolveExecution: args => execution(call, "launch", z.object({ bundleId: z.string().min(1).max(256) }).strict().parse(args), true)
    },
    {
      name: "ComputerMirror", description: "Open a live mirror of an approved native window without raising the application. Choose an exact pid/windowId from ComputerList. onMinimize arms presentation when the user minimizes the window. List mirrors and frame age, or close this session's mirrors. Does not restore or activate the source window.", risk: "execute", capability: "computer.mirror",
      parameters: { type: "object", properties: { operation: { type: "string", enum: ["open", "close", "list"] }, ...commonProperties, onMinimize: { type: "boolean" }, all: { type: "boolean" } }, required: ["operation"], additionalProperties: false }, schema: computerMirrorSchema,
      resolveExecution: args => execution(call, "mirror", computerMirrorSchema.parse(args), true)
    },
    {
      name: "ComputerList", description: "List native apps, or exact windows of a pid. Requires user-enabled desktop control in Biny settings. Browser tasks should prefer Browser/ChromeRelay tools.", risk: "read", capability: "computer.list",
      parameters: { type: "object", properties: { pid: commonProperties.pid, days: { type: "integer", minimum: 0, maximum: 90 } }, additionalProperties: false }, schema: computerListSchema,
      resolveExecution: args => execution(call, "list", computerListSchema.parse(args), false)
    },
    {
      name: "ComputerObserve", description: "Observe one exact native window, returning an image, fresh capture_id and element tokens. This screenshot is sent to the current model only after the execution service checks the target application approval; it is not saved to Activity memory.", risk: "read", capability: "computer.observe",
      parameters: { type: "object", properties: { ...commonProperties,
        maxElements: { type: "integer", minimum: 1, maximum: 1000 },
        depth: { type: "integer", minimum: 1, maximum: 20, description: "AX tree depth, from 1 to 20." },
        screenshotMaxWidth: { type: "integer", minimum: 1, description: "Downsample width of the screenshot, default 1280." },
        interactiveOnly: { type: "boolean", description: "Limit the element list to interactive elements. Default true; set false for the full tree." },
      }, required: ["pid", "windowId"], additionalProperties: false }, schema: windowObserveSchema,
      resolveExecution: args => execution(call, "observe", windowObserveSchema.parse(args), false)
    },
    {
      name: "ComputerAction", description: "操作获准应用中刚观察的准确窗口，并返回新的验证画面。坐标必须来自当前观察凭据。默认后台投递；拒绝后不能自动重试前台输入，前台投递须经用户开启和授权。已投递后核对业务结果；效果待核对不表示调用失败。", risk: "execute", capability: "computer.action",
      promptGuidelines: [
        "Use this MCP control plane for native desktop input, not Bash, biny cu, osascript, Quartz, clipboard paste or another daemon. A paused, denied, unavailable or unverified action never authorizes an alternate input or activation path.",
        "Use ComputerList, then ComputerObserve to choose an exact target; never guess IDs, element tokens or screenshot coordinates. Prefer a usable element token; custom-drawn controls without tokens require screenshot coordinates.",
        "type_text with auto, physical or unicode may omit elementToken and uses the target's keyboard focus. Only inputMethod=ax requires a writable elementToken. Click the field first, inspect the returned observation for focus, then type with its fresh capture_id.",
        "If application approval is required, ask the user to approve the app in Settings → Computer Use. Global tool approval does not override strict application approval.",
        "默认后台投递。只有观察返回 foregroundAllowed 为 true 且任务确实需要时，才显式选择 delivery=foreground；否则须由用户在设置中开启。后台失败不能自动升级到前台；请求中断时停止输入，不重放可能已经发生的动作。",
        "已投递的动作仍须核对业务结果。已有新画面和观察凭据时直接检查并决定下一步，不要为了核对再重复观察或重放动作；只有缺少所需信息或画面尚在加载时才重新观察。请求中断导致执行情况未知时停止输入，不自动重试。",
        "Scroll directions describe content navigation (up decreases vertical offset; right increases horizontal offset). Amount is in pages, default 1. Native scroll areas use measured scrollbar ratios; web content uses estimated wheel notches. Check the reply's unit field if the distance matters.",
        "The live preview is for supervision; its frames do not refresh capture_id or element tokens. Verify the requested UI postcondition, not merely a changed picture."
      ],
      parameters: { type: "object", properties: { ...commonProperties, action: { type: "string", enum: ["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"], description: "click/type_text/press_key/scroll are the common four. drag moves the mouse between two screenshot points. perform_secondary_action opens the element context menu. set_value writes an accessibility value directly (sliders, steppers, fields) without keystrokes. select_text uses location/length to select a range or move the cursor; supplying text replaces the current selection, it does not search for matching text." }, captureId: { type: "string" }, delivery: { type: "string", enum: ["background", "foreground"] },
        button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 }, strategy: { type: "string", enum: ["auto", "physical", "ax"] }, coordinateSpace: { type: "string", enum: ["screenshot", "screen"] }, showCursor: { type: "boolean", description: "Set false to hide the action indicator for this one action." },
        inputMethod: { type: "string", enum: ["auto", "physical", "unicode", "ax"], description: "How to deliver text: physical uses the selected keyboard layout and rejects unrepresentable text before input; auto chooses writable AX with a ref, then a complete physical key plan, then Unicode; unicode uses keyboard focus; ax writes the element directly." }, x: { type: "number" }, y: { type: "number" }, text: { type: "string", maxLength: 4000 }, key: { type: "string", maxLength: 40 }, elementToken: { type: "string" }, direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Content navigation: up/left decrease the corresponding scroll offset; down/right increase it." }, pages: { type: "integer", minimum: 1, maximum: 20, description: "How many pages to scroll, default 1. A page is the viewport, measured from the scroll area rather than guessed; the reply says whether it was measured or estimated. Zero is rejected before dispatch." },
        x1: { type: "number", description: "drag: start point in screenshot pixels." }, y1: { type: "number" },
        x2: { type: "number", description: "drag: end point in screenshot pixels." }, y2: { type: "number" },
        value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }], description: "set_value: the value to write, matching the control's own type." },
        location: { type: "integer", minimum: 0, description: "select_text: character offset to place the cursor at when no text is given." },
        length: { type: "integer", minimum: 0, description: "select_text: characters to select from location. Default 0 (cursor only)." } }, required: ["pid", "windowId", "action", "captureId"], additionalProperties: false }, schema: computerActionSchema,
      resolveExecution: args => execution(call, "action", computerActionSchema.parse(args), true)
    }
  ];
  return tools.map(tool => ({ ...tool, source: "mcp", exposure: "direct", namespace: { name: "computer-use", description: "Approved Desktop windows" } }));
}
function execution(call: ComputerToolCaller, method: string, args: Record<string, unknown>, mutation: boolean) {
  return {
    accesses: ToolAccesses.browser("biny:single-desktop"), retrySafety: mutation ? "unsafe" as const : "safe" as const,
    approvalRule: `computer_${method}`,
    description: `Computer ${typeof args.action === "string" ? args.action : method} · pid ${String(args.pid ?? "apps")} · window ${String(args.windowId ?? "list")} · ${String(args.delivery ?? "background")}`,
    display: { kind: "generic" as const, summary: `Computer ${method}`, detail: { ...args, text: args.text === undefined ? undefined : "[input hidden]" } },
    async execute(context: ToolExecutionContext): Promise<unknown> {
      if (!context.sessionId) throw new Error("Computer use requires an Agent session.");
      const reply = await call(method, args, context, mutation);
      const error = reply.errorCode;
      const image = reply.errorCode ? undefined : reply.images[0];
      const imageReturned = image ? context.onImage?.({ type: "image", mimeType: image.mimeType, data: image.dataBase64 }) === true : false;
      // 无障碍树按行集交给模型：同样 301 个元素，紧凑 JSON 要 40KB，行集只要 12.7KB，
      // 而观察是要反复做的。element_token 留在行首括号里，动作仍按 token 引用。
      const { elements, ...rest } = reply.data as { elements?: ElementLike[] } & Record<string, unknown>;
      const tree = renderElementTree(elements);
      return { ...rest, ...(tree ? { tree } : {}), error, imageReturned, ...(reply.images.length && !imageReturned ? { observationImageUnavailable: true, observationRequired: true, doNotRepeat: mutation } : {}) };
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
