import { LocalComputerMcpPolicy, type ComputerMcpPolicy } from "./mcpPolicy.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderElementTree, type ElementLike } from "./elementTree.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applicationPlaybook } from "./playbooks.js";
import { NativeProcessDriver } from "./nativeDriver.js";
import type { DriverReply } from "./controller.js";
import { computerActionPayload, computerObservationOptions, computerSequenceSchema } from "./protocol.js";

import { legacyActionPayload, legacyActionShape, legacyComputerTarget, legacyObservationOptions } from "./input.js";
import { toNativeActionArgs, toNativeObservationArgs } from "./nativeArgs.js";

const appSchema = legacyComputerTarget;

export function createComputerUseMcpServer(driver: NativeProcessDriver, policy: ComputerMcpPolicy = new LocalComputerMcpPolicy(driver)): McpServer {
  const server = new McpServer(
    { name: "computer-use", version: "1.0.0" },
    {
      instructions:
        "通过 Biny 操作 macOS 原生应用。先观察准确窗口，再使用该次观察中的控件引用或截图坐标。\n" +
        "优先使用无障碍控件；输入默认后台投递，不自动升级到前台。每次输入消费观察凭据，" +
        "下一次输入前重新观察，或使用桌面控制器明确返回的新观察。纯回执截图不更新控件引用。\n" +
        "动作已投递不代表业务目标完成。已有新画面时直接核对并决定下一步，缺少所需信息时才重新观察。请求中断时停止输入，不重放动作；暂停和人工接管后等待用户恢复。"
    }
  );

  const asText = (value: unknown): string => JSON.stringify(value, null, 1);
  const withPostShot = async (pid: number | undefined, reply: DriverReply, windowID?: number): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> => {
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: asText({ ...reply.data, error: reply.errorCode, verificationRequired: !reply.errorCode, observationRequired: true, doNotRepeat: !reply.errorCode }) }];
    if (reply.errorCode) return { isError: true, content, structuredContent: { effect: "refused" } };
    try {
      const shot = await (pid && windowID ? driver.capturePreview({ pid, windowId: String(windowID) }) : driver.captureWindow(pid));
      const image = (shot.images ?? [])[0];
      if (image) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
    } catch { /* 截图拿不到不该让动作本身算失败 */ }
    return { content, structuredContent: { effect: reply.data.effect } };
  };
  const fail = (error: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
  });

  function registerTool<Shape extends z.ZodRawShape>(name: string, config: { title?: string; description?: string; inputSchema: Shape }, callback: ToolCallback<Shape>) {
    const guarded: ToolCallback<z.ZodRawShape> = async (args, extra) => {
      try {
        if (computerActionPayload.shape.action.safeParse(name).success) legacyActionPayload(name, args);
        if (name === "get_app_state") legacyObservationOptions(args);
        return await policy.run(name, args as Record<string, unknown>, async () => await (callback as ToolCallback<z.ZodRawShape>)(args, extra), extra.signal); }
      catch (error) { return fail(error); }
    };
    const inputSchema = z.object(config.inputSchema).strict();
    return server.registerTool<z.ZodRawShape, typeof inputSchema>(name, { ...config, inputSchema }, guarded as ToolCallback<typeof inputSchema>);
  }

  registerTool("pip_open", {
    description: "Open a mirror of an exact window without raising its app. Set on_minimize to arm automatic presentation when the user minimizes that window. A stopped frame stays visible with its age; no window is restored or activated.",
    inputSchema: { window_id: z.number().int().positive().max(4294967295), pid: appSchema.pid, on_minimize: z.boolean().optional() }
  }, async args => {
    try { return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_open", args)).data) }] }; }
    catch (error) { return fail(error); }
  });
  registerTool("pip_close", {
    description: "Close one window mirror by window_id or all mirrors with all=true. Also disarms automatic presentation on minimize.",
    inputSchema: { window_id: z.number().int().positive().max(4294967295).optional(), all: z.boolean().optional() }
  }, async ({ window_id, all }) => {
    try { return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_close", { window_id, all })).data) }] }; }
    catch (error) { return fail(error); }
  });
  registerTool("pip_list", {
    description: "List open window mirrors and armed minimize observers, including last_frame_age_ms (null before the first frame) and capture errors.", inputSchema: {}
  }, async () => {
    try { return { content: [{ type: "text" as const, text: asText((await driver.daemonCommand("pip_list")).data) }] }; }
    catch (error) { return fail(error); }
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
      try {
        const reply = await driver.launchApp(bundle, extra.signal);
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
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
      try {
        const reply = await driver.daemonCommand("list_apps", { recent_days: days });
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
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
        autoLaunch: z.boolean().optional()
          .describe("Auto-launch the app in the background if not running. Default true.")
      }
    },
    async (input, extra) => {
      try {
        const reply = await driver.observeRaw({
          ...toNativeObservationArgs({ ...legacyObservationOptions(input), pid: input.pid, windowId: input.window_id === undefined ? undefined : String(input.window_id) }),
          bundle: input.bundle, auto_launch: input.autoLaunch
        }, extra.signal);
        const { elements, playbook, ...rest } = reply.data as { elements?: ElementLike[] } & Record<string, unknown>;
        const tree = renderElementTree(elements);
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: [asText(rest), tree, typeof playbook === "string" ? playbook : applicationPlaybook(rest.bundleId ?? rest.bundle)].filter(Boolean).join("\n") }
        ];
        const image = (reply.images ?? [])[0];
        if (image) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
        return { content };
      } catch (error) { return fail(error); }
    }
  );

  const actionHandler = (action: import("./protocol.js").ComputerAction["action"]): ToolCallback<z.ZodRawShape> => async (args, extra) => {
    const payload = legacyActionPayload(action, args);
    const pid = args.pid as number | undefined;
    const windowId = args.window_id as number | undefined;
    const reply = await driver.actRaw(action, {
      ...toNativeActionArgs({ ...payload, pid, windowId: windowId === undefined ? undefined : String(windowId) }), bundle: args.bundle
    }, pid, extra.signal);
    return await withPostShot(pid, reply, windowId);
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
      description: "Type text into the target app. Focus the destination first with click, or pass inputMethod=ax with a ref to write the element directly without needing focus. Multi-byte text is delivered character by character. If the reply carries verification_note, the text was sent but landing could not be confirmed — verify before assuming it was written. Do NOT bring the app to the front to make typing land; that costs the user their focus. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("type_text")
    },
    actionHandler("type_text")
  );

  registerTool(
    "press_key",
    {
      title: "Press key",
      description: "Press a key or chord in xdotool syntax: cmd+s, ctrl+shift+t, Return, Escape, F1. A keystrokes_may_be_dropped warning means the app had nothing focused to receive it. Returns the post-action screenshot.",
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
      description: "Mouse drag from one screenshot point to another. The accessibility API has no drag action, so this synthesises a press-move-release sequence. Returns the post-action screenshot.",
      inputSchema: legacyActionShape("drag")
    },
    actionHandler("drag")
  );

  registerTool(
    "perform_secondary_action",
    {
      title: "Open context menu",
      description: "Right-click, or open the context menu of an element by ref. Tries the accessibility ShowMenu action first and falls back to a synthesised right-click. Returns the post-action screenshot.",
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
      description: "按位置选择文本，或使用 matchText 和可选前后文唯一匹配选区。重复匹配时拒绝，不默认选第一处。text 用于替换当前选区，不能与 matchText 混用。返回动作后截图。",
      inputSchema: legacyActionShape("select_text")
    },
    actionHandler("select_text")
  );

  registerTool("sequence", {
    title: "连续动作", description: "通过 Desktop 在同一窗口连续执行最多 5 步。首步之后只允许输入或按键；发生拒绝、回图失败或中断立即停止，不自动重放。使用最近观察的 capture_id 作为 captureId。",
    inputSchema: computerSequenceSchema.innerType().shape
  }, async () => fail(new Error("computer_desktop_required: 连续动作需要正在运行的 Desktop 控制器")));

  registerTool(
    "grant",
    {
      title: "Request permissions",
      description: "Poke macOS to raise its Accessibility prompt for the helper. Only call this when permissions reports Accessibility missing — it puts a dialog on the user's screen.",
      inputSchema: {}
    },
    async () => {
      try {
        const reply = await driver.grantAccessibility();
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
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
      try {
        const reply = await driver.diagnostics();
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
    }
  );

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
