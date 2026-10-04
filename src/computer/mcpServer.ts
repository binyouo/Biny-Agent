// Computer Use 的第二个出口：stdio 形态的 MCP server。
//
// Alma 把同一份能力暴露两遍——产品内工具走自己的通道，外部 MCP 客户端走
// stdio server（alma-reverse: 16-电脑操控 §4「双形态暴露」）。能力层只做一次，
// 协议面按消费者各自包装；这里复用同一个 NativeProcessDriver 和同一个 daemon。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NativeProcessDriver } from "./nativeDriver.js";

const appSchema = { pid: z.number().int().positive().optional(), bundle: z.string().min(1).optional() };

export function createComputerUseMcpServer(driver: NativeProcessDriver): McpServer {
  const server = new McpServer(
    { name: "biny-computer-use", version: "1.0.0" },
    {
      instructions:
        "Drive native macOS apps through Biny.\n\n" +
        "Start every turn with get_app_state: it returns the accessibility tree and a window\n" +
        "screenshot in one round trip. Element refs are scoped to the latest snapshot, so\n" +
        "re-snapshot when you see ref_stale.\n\n" +
        "Actions never front an app and never move the user's real cursor. An action whose\n" +
        "delivery is interrupted may have unknown outcome — re-observe instead of replaying it."
    }
  );

  const asText = (value: unknown): string => JSON.stringify(value, null, 1);
  /**
   * 动作回执：文字确认 + 动作后的新截图。
   * Alma 的每个动作工具都这么做——模型执行完一步就能看到结果，
   * 不必再 observe 一次（那会多花一个来回和一棵 AX 树）。
   */
  const withPostShot = async (pid: number | undefined, text: string): Promise<{ content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] }> => {
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text }];
    try {
      const shot = await driver.captureWindow(pid);
      const image = (shot.images ?? [])[0];
      if (image) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
    } catch { /* 截图拿不到不该让动作本身算失败 */ }
    return { content };
  };
  const fail = (error: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
  });

  server.registerTool(
    "launch_app",
    {
      title: "Launch app",
      description:
        "Launch an app by bundle id WITHOUT bringing it to the foreground. No-op if it is already running. The user's focus is never disturbed.",
      inputSchema: { bundle: z.string().min(1).describe("Bundle identifier, e.g. com.apple.TextEdit") }
    },
    async ({ bundle }) => {
      try {
        const reply = await driver.launchApp(bundle);
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description: "List running apps with their bundle ids and pids, so you can pick an observation target.",
      inputSchema: {}
    },
    async () => {
      try {
        const reply = await driver.list("mcp", undefined);
        return { content: [{ type: "text" as const, text: asText(reply.data) }] };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "get_app_state",
    {
      title: "Observe a window",
      description:
        "Snapshot one app window: returns the accessibility tree (role, title, value, frame, and a stable ref per element) plus a screenshot. Call this once per turn before acting. If the app is not running the call fails — use launch_app first.",
      inputSchema: { ...appSchema, maxElements: z.number().int().positive().max(1000).optional() }
    },
    async ({ pid, bundle, maxElements }) => {
      try {
        const args: Record<string, unknown> = {};
        if (pid !== undefined) args.pid = pid;
        if (bundle !== undefined) args.bundle = bundle;
        if (maxElements !== undefined) args.max_elements = maxElements;
        const reply = await driver.observeRaw(args);
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: asText(reply.data) }
        ];
        const image = (reply.images ?? [])[0];
        if (image) content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
        return { content };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "click",
    {
      title: "Click",
      description:
        "Click an element by ref from the latest get_app_state, or at absolute screenshot pixel (x, y). Refs go through the accessibility API; pixels are dispatched straight to the target process. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).optional().describe("Element ref from the latest snapshot"),
        x: z.number().optional(), y: z.number().optional(),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ ref, x, y, pid }) => {
      try {
        if (!ref && (x === undefined || y === undefined)) throw new Error("click requires either ref or x/y");
        const reply = await driver.actRaw("click", ref ? { ref: ref as string } : { x: x as number, y: y as number }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: "Type text into the target app. Focus the destination first with click. Multi-byte text is delivered character by character. If the reply carries a keystrokes_may_be_dropped warning the app had nothing focused to receive them — treat it as not written. Returns the post-action screenshot.",
      inputSchema: { text: z.string().min(1).max(4000), pid: z.number().int().positive().optional() }
    },
    async ({ text, pid }) => {
      try {
        const reply = await driver.actRaw("type_text", { text }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "press_key",
    {
      title: "Press key",
      description: "Press a key or chord in xdotool syntax: cmd+s, ctrl+shift+t, Return, Escape, F1. A keystrokes_may_be_dropped warning means the app had nothing focused to receive it. Returns the post-action screenshot.",
      inputSchema: { key: z.string().min(1).max(40), pid: z.number().int().positive().optional() }
    },
    async ({ key, pid }) => {
      try {
        const reply = await driver.actRaw("press_key", { key }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: "Scroll the target app up, down, left or right by a number of lines. Returns the post-action screenshot.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(10).optional(),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ direction, amount, pid }) => {
      try {
        const reply = await driver.actRaw("scroll", { direction, amount: amount ?? 3 }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Mouse drag from one screenshot point to another. The accessibility API has no drag action, so this synthesises a press-move-release sequence. Returns the post-action screenshot.",
      inputSchema: {
        x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ x1, y1, x2, y2, pid }) => {
      try {
        const reply = await driver.actRaw("drag", { x1, y1, x2, y2 }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "perform_secondary_action",
    {
      title: "Open context menu",
      description: "Right-click, or open the context menu of an element by ref. Tries the accessibility ShowMenu action first and falls back to a synthesised right-click. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).optional(), x: z.number().optional(), y: z.number().optional(),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ ref, x, y, pid }) => {
      try {
        if (!ref && (x === undefined || y === undefined)) throw new Error("perform_secondary_action requires either ref or x/y");
        const reply = await driver.actRaw("perform_secondary_action", ref ? { ref } : { x: x as number, y: y as number }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "set_value",
    {
      title: "Set value",
      description: "Write an element's value directly through the accessibility API, for sliders, steppers and text fields. Skips keystroke simulation. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from the latest snapshot"),
        value: z.union([z.string(), z.number(), z.boolean()]),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ ref, value, pid }) => {
      try {
        const reply = await driver.actRaw("set_value", { ref, value }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "select_text",
    {
      title: "Select text",
      description: "Select a run of text inside an editable element, or place the cursor at a character offset when no text is given. Returns the post-action screenshot.",
      inputSchema: {
        ref: z.string().min(1).describe("Element ref from the latest snapshot"),
        text: z.string().min(1).optional(),
        location: z.number().int().nonnegative().optional(),
        length: z.number().int().nonnegative().optional(),
        pid: z.number().int().positive().optional()
      }
    },
    async ({ ref, text, location, length, pid }) => {
      try {
        if (text === undefined && location === undefined) throw new Error("select_text requires text or location");
        const reply = await driver.actRaw("select_text", text !== undefined ? { ref, text } : { ref, location, length: length ?? 0 }, pid);
        return await withPostShot(pid, asText(reply.data));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
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

  server.registerTool(
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

  return server;
}

export async function runComputerUseMcpServer(): Promise<void> {
  const driver = new NativeProcessDriver(() => undefined);
  const server = createComputerUseMcpServer(driver);
  const transport = new StdioServerTransport();
  const shutdown = (): void => { void driver.dispose().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}
