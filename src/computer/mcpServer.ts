import { LocalComputerMcpPolicy, type ComputerMcpPolicy } from "./mcpPolicy.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderElementTree, type ElementLike } from "./elementTree.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applicationPlaybook } from "./playbooks.js";
import { NativeProcessDriver } from "./nativeDriver.js";
import type { DriverReply } from "./controller.js";

const appSchema = { pid: z.number().int().positive().optional(), bundle: z.string().min(1).optional(), window_id: z.number().int().positive().max(4294967295).optional() };

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
      try { return await policy.run(name, args as Record<string, unknown>, async () => await (callback as ToolCallback<z.ZodRawShape>)(args, extra), extra.signal); }
      catch (error) { return fail(error); }
    };
    return server.registerTool<z.ZodRawShape, z.ZodRawShape>(name, config, guarded);
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
        maxElements: z.number().int().positive().max(1000).optional(),
        depth: z.number().int().min(1).max(20).optional().describe("AX tree depth, from 1 to 20."),
        screenshotMaxWidth: z.number().int().positive().optional()
          .describe("Downsample width for the screenshot (default 1280)."),
        interactiveOnly: z.boolean().optional().describe("Limit to interactive elements. Default true."),
        autoLaunch: z.boolean().optional()
          .describe("Auto-launch the app in the background if not running. Default true.")
      }
    },
    async ({ pid, bundle, window_id, maxElements, depth, screenshotMaxWidth, interactiveOnly, autoLaunch }, extra) => {
      try {
        const args: Record<string, unknown> = {};
        if (pid !== undefined) args.pid = pid;
        if (bundle !== undefined) args.bundle = bundle;
        if (maxElements !== undefined) args.max_elements = maxElements;
        if (depth !== undefined) args.max_depth = depth;
        if (window_id !== undefined) args.window_id = window_id;
        if (screenshotMaxWidth !== undefined) args.max_width = screenshotMaxWidth;
        if (interactiveOnly !== undefined) args.interactive_only = interactiveOnly;
        if (autoLaunch !== undefined) args.auto_launch = autoLaunch;
        const reply = await driver.observeRaw(args, extra.signal);
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

  registerTool(
    "click",
    {
      title: "Click",
      description:
        "使用最新观察中的控件引用或截图坐标点击。优先控件引用；坐标点击默认后台投递，不自动切换到前台。返回动作后截图；投递不等于业务目标已完成。",
      inputSchema: {
        ref: z.string().min(1).optional().describe("Element ref from the latest snapshot"),
        x: z.number().finite().optional(), y: z.number().finite().optional(),
        button: z.enum(["left", "right", "middle"]).optional(), click_count: z.number().int().min(1).max(3).optional(),
        strategy: z.enum(["auto", "physical", "ax"]).optional(), coord_space: z.enum(["screenshot", "screen"]).optional(),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ ref, x, y, pid, bundle, window_id, button, click_count, strategy, coord_space, show_cursor }, extra) => {
      try {
        if (!ref && (x === undefined || y === undefined)) throw new Error("click requires either ref or x/y");
        const reply = await driver.actRaw("click", { ref, x, y, bundle, window_id, button, clicks: click_count, strategy, coord_space, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type text into the target app. Focus the destination first with click, or pass inputMethod=ax with a ref to write the element directly without needing focus. Multi-byte text is delivered character by character. If the reply carries verification_note, the text was sent but landing could not be confirmed — verify before assuming it was written. Do NOT bring the app to the front to make typing land; that costs the user their focus. Returns the post-action screenshot.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        ...appSchema,
        inputMethod: z.enum(["auto", "physical", "unicode", "ax"]).optional()
          .describe("physical uses the selected keyboard layout and rejects unrepresentable text before input. auto chooses writable AX with a ref, then a complete physical key plan, then Unicode; ax needs ref."),
        ref: z.string().min(1).optional().describe("Required when inputMethod is ax"),
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ text, pid, bundle, window_id, inputMethod, ref, show_cursor }, extra) => {
      try {
        const reply = await driver.actRaw("type_text", {
          text, show_cursor, bundle, window_id,
          input_method: inputMethod, ref
        }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "press_key",
    {
      title: "Press key",
      description: "Press a key or chord in xdotool syntax: cmd+s, ctrl+shift+t, Return, Escape, F1. A keystrokes_may_be_dropped warning means the app had nothing focused to receive it. Returns the post-action screenshot.",
      inputSchema: { key: z.string().min(1).max(40), ...appSchema, show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action") }
    },
    async ({ key, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        const reply = await driver.actRaw("press_key", { key, bundle, window_id, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "scroll",
    {
      title: "Scroll",
      description: "Scroll the target app up, down, left or right by a number of lines. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(),
        direction: z.enum(["up", "down", "left", "right"]),
        pages: z.number().int().min(1).max(20).optional(),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ ref, x, y, direction, pages, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        if (!ref && (x === undefined || y === undefined)) throw new Error("scroll requires ref or x/y");
        const reply = await driver.actRaw("scroll", { ref, x, y, direction, pages: pages ?? 1, bundle, window_id, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "drag",
    {
      title: "Drag",
      description: "Mouse drag from one screenshot point to another. The accessibility API has no drag action, so this synthesises a press-move-release sequence. Returns the post-action screenshot.",
      inputSchema: {
        x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), coord_space: z.enum(["screenshot", "screen"]).optional(),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ x1, y1, x2, y2, coord_space, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        const reply = await driver.actRaw("drag", { x1, y1, x2, y2, bundle, window_id, coord_space, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "perform_secondary_action",
    {
      title: "Open context menu",
      description: "Right-click, or open the context menu of an element by ref. Tries the accessibility ShowMenu action first and falls back to a synthesised right-click. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).optional(), x: z.number().optional(), y: z.number().optional(),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ ref, x, y, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        if (!ref && (x === undefined || y === undefined)) throw new Error("perform_secondary_action requires either ref or x/y");
        const reply = await driver.actRaw("perform_secondary_action", { ref, x, y, bundle, window_id, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "set_value",
    {
      title: "Set value",
      description: "Write an element's value directly through the accessibility API, for sliders, steppers and text fields. Skips keystroke simulation. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from the latest snapshot"),
        value: z.union([z.string(), z.number(), z.boolean()]),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ ref, value, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        const reply = await driver.actRaw("set_value", { ref, value, bundle, window_id, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

  registerTool(
    "select_text",
    {
      title: "Select text",
      description: "在可编辑控件中按位置和长度选择文本，长度为零时移动光标。传入 text 会替换当前选区，不用于查找或选择匹配文本。返回动作后截图。",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from the latest snapshot"),
        text: z.string().min(1).optional(),
        location: z.number().int().nonnegative().optional(),
        length: z.number().int().nonnegative().optional(),
        ...appSchema,
        show_cursor: z.boolean().optional().describe("Set false to hide the action indicator for this one action")
      }
    },
    async ({ ref, text, location, length, pid, bundle, window_id, show_cursor }, extra) => {
      try {
        if (text === undefined && location === undefined) throw new Error("select_text requires text or location");
        const reply = await driver.actRaw("select_text", { ref, text, location, length: length ?? 0, bundle, window_id, show_cursor }, pid, extra.signal);
        return await withPostShot(pid, reply, window_id);
      } catch (error) { return fail(error); }
    }
  );

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
