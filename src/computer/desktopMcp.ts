import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpToolHost } from "../extensions/mcp.js";
import { createComputerUseTools, requestComputer } from "../tools/computerUse.js";
import type { BrowserAutomationEndpoint } from "../tools/browser.js";
import { ToolOutcomeUnknownError } from "../tools/types.js";
import type { DriverReply } from "./controller.js";
import { computerImageSchema } from "./protocol.js";
import { resolveComputerMcpLease, type ComputerMcpLease } from "./mcpLease.js";

export const desktopComputerMcpName = "computer-use";
const toolMethods: Record<string, string> = { ComputerLaunch: "launch", ComputerList: "list", ComputerObserve: "observe", ComputerAction: "action", ComputerSequence: "sequence", ComputerMirror: "mirror" };
const replySchema = z.object({ data: z.record(z.unknown()), errorCode: z.string().optional(), images: z.array(computerImageSchema) });

export function attachNativeComputerMcp(host: McpToolHost): Promise<void> {
  return host.attachLocalServer(desktopComputerMcpName, "native", undefined, async () => {
    const { NativeProcessDriver } = await import("./nativeDriver.js");
    const { createComputerUseMcpServer } = await import("./mcpServer.js");
    const closed = new AbortController();
    const openSession = async () => {
      closed.signal.throwIfAborted();
      const driver = new NativeProcessDriver(() => undefined);
      const server = createComputerUseMcpServer(driver);
      const client = new Client({ name: "biny-computer", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => closePromise ??= (async () => {
        const failures: unknown[] = [];
        try { await client.close(); } catch (error) { failures.push(error); }
        try { await server.close(); } catch (error) { failures.push(error); }
        // daemon 由多个客户端共用；会话退出只断开自己的 driver，不终止其他会话的进程。
        try { driver.detach(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "Native Computer Use session cleanup failed.");
      })();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        closed.signal.throwIfAborted();
        return { client, close };
      } catch (error) { await close(); throw error; }
    };
    const catalog = openSession();
    const sessions = new Map<string, { pending: ReturnType<typeof openSession>; lifetime: AbortController; close(): Promise<void> }>();
    const catalogClient = (await catalog).client;
    const server = new Server({ name: desktopComputerMcpName, version: "1.0.0" }, {
      capabilities: { tools: {} }, instructions: catalogClient.getInstructions()
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => await catalogClient.listTools());
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      closed.signal.throwIfAborted();
      const sessionId = z.string().min(1).max(240).parse(request.params._meta?.["biny/session-id"]);
      const lease = resolveComputerMcpLease(host, request.params._meta?.["biny/computer-lease-id"]);
      const key = lease ? `runtime:${lease.id}:${sessionId}` : `session:${sessionId}`;
      let session = sessions.get(key);
      if (!session) {
        const pending = openSession();
        const lifetime = new AbortController();
        let closing: Promise<void> | undefined;
        const entry = { pending, lifetime, close: (): Promise<void> => {
          lifetime.abort();
          closing ??= (async () => {
            try { await (await pending).close(); }
            finally {
              unregister?.();
              if (sessions.get(key) === entry) sessions.delete(key);
            }
          })();
          return closing;
        } };
        const unregister = lease?.register(entry.close);
        session = entry;
        sessions.set(key, entry);
        void pending.catch(() => {
          unregister?.();
          if (sessions.get(key) === entry) sessions.delete(key);
        });
      }
      const { client } = await session.pending;
      const signal = AbortSignal.any([closed.signal, extra.signal, session.lifetime.signal]);
      signal.throwIfAborted();
      return await client.callTool({ name: request.params.name, arguments: request.params.arguments }, CallToolResultSchema, { signal });
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      closed.abort();
      const results = await Promise.allSettled([
        server.close(),
        catalog.then(session => session.close()),
        ...[...sessions.values()].map(session => session.close())
      ]);
      sessions.clear();
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Computer Use MCP shutdown failed.");
    })();
    try {
      await server.connect(serverTransport);
    } catch (error) {
      await close();
      throw error;
    }
    return { transport: clientTransport, close };
  });
}

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
      }, { "biny/session-id": context.sessionId, "biny/endpoint-id": identity,
        "biny/computer-lease-id": context.computerMcpLeaseId }, identity);
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
    const sessions = new Map<string, { lease?: ComputerMcpLease; lifetime: AbortController; ready: Promise<void>;
      pending: Set<Promise<DriverReply>>; used: boolean; close(): Promise<void> }>();
    let closePromise: Promise<void> | undefined;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find(tool => tool.name === request.params.name);
      if (!tool) throw new Error(`Unknown Computer Use tool: ${request.params.name}`);
      const session = z.string().min(1).max(240).parse(request.params._meta?.["biny/session-id"]);
      z.literal(identity).parse(request.params._meta?.["biny/endpoint-id"]);
      const args = tool.schema.parse(request.params.arguments ?? {}) as Record<string, unknown>;
      const method = toolMethods[tool.name]!;
      const mutation = method === "action" || method === "sequence" || method === "mirror" || method === "launch";
      closed.signal.throwIfAborted();
      const lease = resolveComputerMcpLease(host, request.params._meta?.["biny/computer-lease-id"]);
      let entry = sessions.get(session);
      if (!entry || entry.lease !== lease) {
        const ready = entry?.close() ?? Promise.resolve();
        const lifetime = new AbortController();
        let closing: Promise<void> | undefined;
        const next = { lease, lifetime, ready, pending: new Set<Promise<DriverReply>>(), used: false, close: (): Promise<void> => {
          lifetime.abort();
          closing ??= (async () => {
            try {
              await ready;
              await Promise.allSettled([...next.pending]);
              if (next.used) await requestComputer(endpoint, "release", { session }, AbortSignal.timeout(2_000));
              if (sessions.get(session) === next) sessions.delete(session);
            } finally { unregister?.(); }
          })();
          return closing;
        } };
        const unregister = lease?.register(next.close);
        entry = next;
        sessions.set(session, next);
      }
      await entry.ready;
      const signal = AbortSignal.any([extra.signal, closed.signal, entry.lifetime.signal]);
      signal.throwIfAborted();
      entry.used = true;
      const pending = requestComputer(endpoint, method, { ...args, session }, signal, mutation);
      entry.pending.add(pending);
      try {
        const reply = await pending;
        return { content: [], structuredContent: reply };
      } catch (error) {
        if (error instanceof ToolOutcomeUnknownError) {
          return { content: [], structuredContent: { outcomeUnknown: true, message: error.message } };
        }
        throw error;
      } finally { entry.pending.delete(pending); }
    });
    await server.connect(serverTransport);
    return { transport: clientTransport, close: () => {
      closePromise ??= (async () => {
        closed.abort();
        const [transport] = await Promise.allSettled([server.close()]);
        const results = await Promise.allSettled([...sessions.values()].map(session => session.close()));
        sessions.clear();
        if (results.some(result => result.status === "rejected")) throw new Error("Desktop ownership release could not be confirmed.");
        if (transport?.status === "rejected") throw new Error("Desktop MCP shutdown failed.", { cause: transport.reason });
      })();
      return closePromise;
    } };
  });
}
