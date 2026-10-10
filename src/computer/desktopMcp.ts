import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpToolHost } from "../extensions/mcp.js";
import { createComputerUseTools, requestComputer } from "../tools/computerUse.js";
import type { BrowserAutomationEndpoint } from "../tools/browser.js";
import { ToolOutcomeUnknownError } from "../tools/types.js";
import type { DriverReply } from "./controller.js";
import { computerImageSchema } from "./protocol.js";

export const desktopComputerMcpName = "computer-use";
const toolMethods: Record<string, string> = { ComputerLaunch: "launch", ComputerList: "list", ComputerObserve: "observe", ComputerAction: "action", ComputerMirror: "mirror" };
const replySchema = z.object({ data: z.record(z.unknown()), errorCode: z.string().optional(), images: z.array(computerImageSchema) });

export function attachDesktopComputerMcp(host: McpToolHost, endpoint: BrowserAutomationEndpoint): Promise<void> {
  const identity = createHash("sha256").update(JSON.stringify(endpoint)).digest("hex");
  const tools = createComputerUseTools(async (method, args, context, mutation): Promise<DriverReply> => {
    const name = Object.keys(toolMethods).find(name => toolMethods[name] === method)!;
    let dispatched = false;
    try {
      const result = await host.callServerTool(desktopComputerMcpName, name, args, context.signal, true, () => {
        dispatched = true;
        context.onDispatched?.();
        context.onExecutionState?.("admitted", "Desktop MCP request dispatched.");
      }, { "biny/session-id": context.sessionId, "biny/endpoint-id": identity }, identity);
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      const uncertain = z.object({ outcomeUnknown: z.literal(true), message: z.string() }).safeParse(structured);
      if (uncertain.success) throw new ToolOutcomeUnknownError("interrupted", uncertain.data.message);
      return replySchema.parse(structured);
    } catch (error) {
      if (mutation && dispatched && context.signal?.aborted) throw new ToolOutcomeUnknownError("cancelled", "Desktop MCP input was cancelled after dispatch. Do not repeat without observation.");
      if (mutation && dispatched && error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new ToolOutcomeUnknownError("timeout", "Desktop MCP input timed out after dispatch. Do not repeat without observation.");
      throw error;
    }
  });
  return host.attachLocalServer(desktopComputerMcpName, identity, tools, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: desktopComputerMcpName, version: "1.0.0" }, { capabilities: { tools: {} } });
    const closed = new AbortController();
    const sessions = new Set<string>();
    let closePromise: Promise<void> | undefined;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find(tool => tool.name === request.params.name);
      if (!tool) throw new Error(`Unknown Computer Use tool: ${request.params.name}`);
      const session = z.string().min(1).max(240).parse(request.params._meta?.["biny/session-id"]);
      z.literal(identity).parse(request.params._meta?.["biny/endpoint-id"]);
      const args = tool.schema.parse(request.params.arguments ?? {}) as Record<string, unknown>;
      const method = toolMethods[tool.name]!;
      const mutation = method === "action" || method === "mirror" || method === "launch";
      closed.signal.throwIfAborted();
      sessions.add(session);
      try {
        const reply = await requestComputer(endpoint, method, { ...args, session }, AbortSignal.any([extra.signal, closed.signal]), mutation);
        return { content: [], structuredContent: reply };
      } catch (error) {
        if (error instanceof ToolOutcomeUnknownError) {
          return { content: [], structuredContent: { outcomeUnknown: true, message: error.message } };
        }
        throw error;
      }
    });
    await server.connect(serverTransport);
    return { transport: clientTransport, close: () => {
      closePromise ??= (async () => {
        closed.abort();
        const [transport] = await Promise.allSettled([server.close()]);
        const results = await Promise.allSettled([...sessions].map(session => requestComputer(endpoint, "release", { session }, AbortSignal.timeout(2_000))));
        sessions.clear();
        if (results.some(result => result.status === "rejected")) throw new Error("Desktop ownership release could not be confirmed.");
        if (transport?.status === "rejected") throw new Error("Desktop MCP shutdown failed.", { cause: transport.reason });
      })();
      return closePromise;
    } };
  });
}
