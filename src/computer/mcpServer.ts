import { LocalComputerMcpPolicy, type ComputerMcpPolicy } from "./mcpPolicy.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { externalElements, renderElementTree, type ElementLike } from "./elementTree.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applicationPlaybook } from "./playbooks.js";
import { NativeProcessDriver } from "./nativeDriver.js";
import type { DriverReply } from "./controller.js";
import { computerActionPayload, computerObservationOptions, computerSequenceSchema } from "./protocol.js";

import { legacyActionPayload, legacyActionShape, legacyAutoLaunch, legacyComputerTarget, legacyObservationOptions } from "./input.js";
import { toNativeActionArgs, toNativeObservationArgs } from "./nativeArgs.js";
import { registerSkyComputerTools, type SkyDispatchOptions } from "./skyMcp.js";

const appSchema = legacyComputerTarget;
type InternalToolCallback<Shape extends z.ZodRawShape> = (args: Parameters<ToolCallback<Shape>>[0], extra: Parameters<ToolCallback<Shape>>[1], options?: SkyDispatchOptions) => ReturnType<ToolCallback<Shape>>;

export function createComputerUseMcpServer(driver: NativeProcessDriver, policy: ComputerMcpPolicy = new LocalComputerMcpPolicy(driver)): McpServer {
  const server = new McpServer(
    { name: "computer-use", version: "1.0.0" },
    {
      // Bound SDK validation before Zod allocates per-element errors. Even a
      // five-step sequence with every declared field uses at most 140 elements.
      maxToolInputElements: 256,
      instructions:
        "通过 Biny 操作 macOS 原生应用。先观察准确窗口，再使用该次观察中的控件引用或截图坐标。\n" +
        "优先使用无障碍控件；输入默认后台投递，不自动升级到前台。每次输入消费观察凭据，" +
        "下一次输入前重新观察，或使用明确返回的新观察。sky 动作会尝试刷新观察并保留同一控件的编号；纯回执截图不更新控件引用。\n" +
        "动作已投递不代表业务目标完成。已有新画面时直接核对并决定下一步，缺少所需信息时才重新观察。请求中断时停止输入，不重放动作；暂停和人工接管后等待用户恢复。"
    }
  );

  const asText = (value: unknown): string => JSON.stringify(value, null, 1);
  const withPostShot = async (pid: number | undefined, reply: DriverReply, windowID?: number, deferShot = false): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> => {
    const receipt: Record<string, unknown> = { ...reply.data, error: reply.errorCode, verificationRequired: !reply.errorCode, observationRequired: true, doNotRepeat: !reply.errorCode };
    const { value: _value, selected: _selected, ...safeReceipt } = receipt;
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: asText(receipt) }];
    if (reply.errorCode) return { isError: true, content, structuredContent: { ...safeReceipt, effect: "refused" } };
    if (deferShot) return { content, structuredContent: { ...safeReceipt, postShotDeferred: true } };
    let screenshotError: string | undefined;
    try {
      const shot = await (pid && windowID ? driver.capturePreview({ pid, windowId: String(windowID) }) : driver.captureWindow(pid));
      const image = (shot.images ?? [])[0];
      if (image && !shot.errorCode) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
      else screenshotError = shot.errorCode ?? (typeof shot.data.screenshot_error === "string" ? shot.data.screenshot_error : "post_action_screenshot_unavailable");
    } catch (error) { screenshotError = error instanceof Error ? error.message : String(error); }
    if (screenshotError) content.push({ type: "text", text: `Post-action screenshot unavailable: ${screenshotError}. Observe the target before the next input; do not repeat the dispatched action automatically.` });
    return { content, structuredContent: { ...safeReceipt, screenshot_error: screenshotError } };
  };
  const fail = (error: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
  });
  const canonical = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; run: InternalToolCallback<z.ZodRawShape> }>();
  let generation = 0;

  function registerTool<Shape extends z.ZodRawShape>(name: string, config: { title?: string; description?: string; inputSchema: Shape }, callback: InternalToolCallback<Shape>) {
    const guarded: InternalToolCallback<z.ZodRawShape> = async (args, extra, options) => {
      try {
        if (computerActionPayload.shape.action.safeParse(name).success) legacyActionPayload(name, args);
        if (name === "get_app_state") legacyObservationOptions(args);
        if (name === "get_app_state" || name === "launch_app" || name === "sequence" || computerActionPayload.shape.action.safeParse(name).success) generation++;
        return await policy.run(name, args as Record<string, unknown>, async () => await (callback as InternalToolCallback<z.ZodRawShape>)(args, extra, options), extra.signal); }
      catch (error) { return fail(error); }
    };
    const inputSchema = z.object(config.inputSchema).strict();
    canonical.set(name, { schema: inputSchema, run: guarded });
    return server.registerTool<z.ZodRawShape, typeof inputSchema>(name, { ...config, inputSchema }, guarded as ToolCallback<typeof inputSchema>);
  }

  registerTool("pip_open", {
    description: "Open a mirror of an exact window without raising its app. Set on_minimize to arm automatic presentation when the user minimizes that window. A stopped frame stays visible with its age; no window is restored or activated.",
    inputSchema: { window_id: z.number().int().positive().max(4294967295), pid: appSchema.pid, on_minimize: z.boolean().optional() }
  }, async args => {
    return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_open", args)).data) }] };
  });
  registerTool("pip_close", {
    description: "Close one window mirror by window_id or all mirrors with all=true. Also disarms automatic presentation on minimize.",
    inputSchema: { window_id: z.number().int().positive().max(4294967295).optional(), all: z.boolean().optional() }
  }, async ({ window_id, all }) => {
    return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_close", { window_id, all })).data) }] };
  });
  registerTool("pip_list", {
    description: "List open window mirrors and armed minimize observers, including last_frame_age_ms (null before the first frame) and capture errors.", inputSchema: {}
  }, async () => {
    return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_list")).data) }] };
  });

  registerTool(
    "launch_app",
    {
      title: "Launch app",
      description:
        "按应用标识请求后台启动；已经运行则返回现有进程。需要应用授权，应用自身仍可能改变焦点。",
      inputSchema: { bundle: z.string().min(1).describe("Bundle identifier, e.g. com.apple.TextEdit") }
    },
    async ({ bundle }, extra) => {
      const reply = await driver.launchApp(bundle, extra.signal);
      return { content: [{ type: "text" as const, text: asText(reply.data) }] };
    }
  );

  registerTool(
    "list_apps",
    {
      title: "List apps",
      description: "List apps you can work with: those currently running (with pid and bundle id, to observe or act on), plus those used in the last 14 days that are not running (bundle id only, no pid) — the latter are your candidates for launch_app. Background-only agents are excluded.",
      inputSchema: { days: z.number().int().min(0).max(90).optional() }
    },
    async ({ days }) => {
      const reply = await driver.daemonCommand("list_apps", { recent_days: days });
      return { content: [{ type: "text" as const, text: asText(reply.data) }] };
    }
  );

  registerTool(
    "get_app_state",
    {
      title: "Observe a window",
      description:
        "Snapshot one app window: returns the accessibility tree (role, title, value, frame, and a stable ref per element) plus a screenshot. Call this once per turn before acting. On apps with no AX tree (Qt / custom-drawn) the elements list is empty but the screenshot is still captured, so you can click by pixel. AUTO-LAUNCH: if the app is not running it is launched in the BACKGROUND — the user's frontmost app stays put.",
      inputSchema: {
        ...appSchema,
        ...computerObservationOptions.shape,
        depth: z.number().int().min(0).max(20).optional().describe("AX tree depth, default 6; 0 captures only the screenshot."),
        interactive_only: computerObservationOptions.shape.interactiveOnly,
        screenshot_max_width: computerObservationOptions.shape.screenshotMaxWidth,
        auto_launch: z.boolean().optional(),
        autoLaunch: z.boolean().optional()
          .describe("Auto-launch the app in the background if not running. Default true.")
      }
    },
    async (input, extra) => {
      const reply = await driver.observeRaw({
        ...toNativeObservationArgs({ ...legacyObservationOptions(input), pid: input.pid, windowId: input.window_id === undefined ? undefined : String(input.window_id) }),
        bundle: input.bundle, auto_launch: legacyAutoLaunch(input)
      }, extra.signal);
      const { elements, playbook, ...rest } = reply.data as { elements?: ElementLike[] } & Record<string, unknown>;
      const tree = renderElementTree(elements);
      const image = (reply.images ?? [])[0];
      const body = { ...rest, elements: externalElements(elements), observationRequired: image ? undefined : true };
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: JSON.stringify(body) }];
      if (tree) content.push({ type: "text", text: tree });
      const book = typeof playbook === "string" ? playbook : applicationPlaybook(rest.bundleId ?? rest.bundle);
      if (book) content.push({ type: "text", text: book });
      if (image) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
      return { content, structuredContent: { ...body, playbook: book || undefined } };
    }
  );

  const actionHandler = (action: import("./protocol.js").ComputerAction["action"]): InternalToolCallback<z.ZodRawShape> => async (args, extra, options) => {
    const payload = legacyActionPayload(action, args);
    const pid = args.pid as number | undefined;
    const windowId = args.window_id as number | undefined;
    const reply = await driver.actRaw(action, {
      ...toNativeActionArgs({ ...payload, pid, windowId: windowId === undefined ? undefined : String(windowId) }), bundle: args.bundle
    }, pid, extra.signal);
    return await withPostShot(pid, reply, windowId, options?.deferActionScreenshot);
  };

  registerTool(
    "click",
    {
      title: "Click",
      description:
        "使用最新观察中的控件引用或截图坐标点击。优先控件引用；坐标点击默认后台投递，不自动切换到前台。返回动作后截图；投递不等于业务目标已完成。",
      inputSchema: legacyActionShape("click")
    },
    actionHandler("click")
  );

  registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type text into the target app. Focus the destination first with click, or pass input_method=ax with a ref to write the element directly without needing focus. Auto tries writable AX first; with a ref, keyboard fallback requires that control or its child to have focus. If the reply carries verification_note, the text was sent but landing could not be confirmed — verify before assuming it was written. Do NOT bring the app to the front to make typing land; that costs the user their focus. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("type_text")
    },
    actionHandler("type_text")
  );

  registerTool(
    "press_key",
    {
      title: "Press key",
      description: "Press a key or chord in xdotool syntax: cmd+s, ctrl+shift+t, Return, Escape, F1, cmd+opt+esc, Super_L+d. Modifiers: cmd/command/meta/super, ctrl/control, shift, opt/option/alt, fn; left/right keysym aliases are accepted. Unknown keys or modifiers are rejected before input. If the app has no focused window, a matching enabled menu shortcut can run through AX when the observed window is its main window; via=menu_ax_press identifies this route. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("press_key")
    },
    actionHandler("press_key")
  );

  registerTool(
    "scroll",
    {
      title: "Scroll",
      description: "Scroll the target app up, down, left or right by a number of pages (default 1). Returns the post-action screenshot.",
      inputSchema: legacyActionShape("scroll")
    },
    actionHandler("scroll")
  );

  registerTool(
    "drag",
    {
      title: "Drag",
      description: "Drag from start_x/start_y to end_x/end_y in screenshot pixels, or set coord_space to screen. Choose left, right or middle button; left is the default. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("drag")
    },
    actionHandler("drag")
  );

  registerTool(
    "perform_secondary_action",
    {
      title: "Open context menu",
      description: "Open a context menu by ref or coordinates. Coordinates use screenshot pixels by default, or screen points with coord_space=screen. A referenced element may also specify secondary_action as an accessibility action name; only the default ShowMenu falls back to a right-click. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("perform_secondary_action")
    },
    actionHandler("perform_secondary_action")
  );

  registerTool(
    "set_value",
    {
      title: "Set value",
      description: "Write an element's value directly through the accessibility API, for sliders, steppers and text fields. Skips keystroke simulation. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("set_value")
    },
    actionHandler("set_value")
  );

  registerTool(
    "select_text",
    {
      title: "Select text",
      description: "Select matching text without changing the field, or place the cursor before or after it. Use prefix and suffix to distinguish repeated text. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("select_text")
    },
    actionHandler("select_text")
  );

  registerTool("sequence", {
    title: "连续动作", description: "通过 Desktop 在同一窗口连续执行最多 5 步。首步之后只允许输入或按键；发生部分完成、拒绝、回图失败或中断立即停止，不自动重放。使用最近观察的 capture_id 作为 captureId。",
    inputSchema: computerSequenceSchema.shape
  }, async () => fail(new Error("computer_desktop_required: 连续动作需要正在运行的 Desktop 控制器")));

  registerTool(
    "grant",
    {
      title: "Request permissions",
      description: "Poke macOS to raise its Accessibility prompt for the helper. Only call this when permissions reports Accessibility missing — it puts a dialog on the user's screen.",
      inputSchema: {}
    },
    async () => {
      const reply = await driver.grantAccessibility();
      return { content: [{ type: "text" as const, text: asText(reply.data) }] };
    }
  );

  registerTool(
    "permissions",
    {
      title: "Permissions",
      description: "Report whether the Accessibility and Screen Recording grants the daemon needs are in place, plus its version and uptime.",
      inputSchema: {}
    },
    async () => {
      const reply = await driver.diagnostics();
      return { content: [{ type: "text" as const, text: asText(reply.data) }] };
    }
  );

  registerSkyComputerTools(server, async (name, args, extra, options) => {
    try {
      if (name === "post_action_screenshot") {
        const target = z.object({ pid: z.number().int().positive(), window_id: z.number().int().positive().max(4294967295), bundle: z.string().min(1) }).strict().parse(args);
        return await policy.run(name, target, async () => {
          const shot = await driver.capturePreview({ pid: target.pid, windowId: String(target.window_id) }, extra.signal);
          if (shot.errorCode || shot.images.length === 0) {
            const reason = shot.errorCode ?? (typeof shot.data.screenshot_error === "string" ? shot.data.screenshot_error : "post_action_screenshot_unavailable");
            return { isError: true, content: [{ type: "text", text: reason }], structuredContent: { screenshot_error: reason } };
          }
          return { content: shot.images.map(image => ({ type: "image" as const, data: image.dataBase64, mimeType: image.mimeType })) };
        }, extra.signal);
      }
      const entry = canonical.get(name);
      if (!entry) return fail(new Error(`Unknown Computer Use tool: ${name}`));
      return await entry.run(entry.schema.parse(args), extra, options);
    } catch (error) { return fail(error); }
  }, () => generation);

  const close = server.close.bind(server);
  server.close = async () => { try { await policy.close?.(); } finally { await close(); } };
  return server;
}

export async function runComputerUseMcpServer(): Promise<void> {
  const driver = new NativeProcessDriver(() => undefined);
  const server = createComputerUseMcpServer(driver);
  const transport = new StdioServerTransport();
  const shutdown = (): void => { void server.close().finally(() => driver.dispose()).finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}
