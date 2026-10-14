const contextLimitBytes = 12 * 1024;
const queryLimitCharacters = 500;
const messageLimit = 5_000;
const messageLimitBytes = 256 * 1024;
const threadLimitBytes = 8 * 1024 * 1024;
const requestTimeoutMs = 5_000;

export default function register(context) {
  const serverName = resolveServerName(context.config, process.env.BINY_NOWLEDGE_MEM_SERVER);
  if (!serverName) return;

  context.registerTurnLifecycle({
    async beforeTurn({ userMessage, useMemories, signal, callMcpTool }) {
      if (!useMemories || typeof callMcpTool !== "function") return undefined;
      const calls = [
        callMcpTool(serverName, "read_context_bundle", {
          source_app: "biny",
          include_working_memory: true,
          format: "markdown",
          include_rendered_markdown: true
        }, requestSignal(signal)),
        ...(userMessage.trim()
          ? [callMcpTool(serverName, "memory_search", {
            query: truncateCharacters(userMessage, queryLimitCharacters),
            limit: 5,
            source_app: "biny"
          }, requestSignal(signal))]
          : [])
      ];
      const results = await Promise.allSettled(calls);
      if (results.every((result) => result.status === "rejected")) throw new Error("Nowledge Mem context retrieval failed.");
      const sections = results.flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const value = resultText(result.value);
        if (!value) return [];
        return [`[${index === 0 ? "Working context" : "Relevant memories"}]\n${value}`];
      });
      const content = truncateUtf8(sections.join("\n\n"), contextLimitBytes);
      return content ? `<nowledge_mem_context>\n${content}\n</nowledge_mem_context>` : undefined;
    },

    async afterTurn({ sessionId, outcome, messages, contributeMemories, signal, callMcpTool }) {
      if (!contributeMemories || outcome.status !== "completed" || typeof callMcpTool !== "function") return;
      const boundedMessages = boundMessages(messages);
      if (!boundedMessages.length) return;
      await callMcpTool(serverName, "sync_thread", {
        thread_id: sessionId,
        source: "biny",
        messages: boundedMessages
      }, requestSignal(signal));
    }
  });
}

function resolveServerName(config, configuredName) {
  const servers = config?.extensions?.mcp;
  if (!servers || typeof servers !== "object") return undefined;
  const enabled = Object.entries(servers).filter(([, server]) => server?.enabled !== false);
  const explicit = configuredName?.trim();
  if (explicit) return enabled.some(([name]) => name === explicit) ? explicit : undefined;

  const named = enabled.filter(([name]) => /nowledge[\s_.-]*mem/iu.test(name));
  if (named.length === 1) return named[0]?.[0];
  if (named.length > 1) return undefined;

  const localService = enabled.filter(([, server]) => {
    if (typeof server?.url !== "string") return false;
    try {
      const url = new URL(server.url);
      return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase()) && url.port === "14242";
    } catch {
      return false;
    }
  });
  return localService.length === 1 ? localService[0]?.[0] : undefined;
}

function requestSignal(parentSignal) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function resultText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (value.isError === true) throw new Error("Nowledge Mem MCP request failed.");
  if (Array.isArray(value.content)) {
    const text = value.content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      if (item.type === "text" && typeof item.text === "string") return [item.text];
      if (item.type === "resource" && typeof item.resource?.text === "string") return [item.resource.text];
      return [];
    }).join("\n").trim();
    if (text) return text;
  }
  if (value.structuredContent !== undefined) {
    return typeof value.structuredContent === "string"
      ? value.structuredContent
      : JSON.stringify(value.structuredContent);
  }
  return "";
}

function boundMessages(messages) {
  const result = [];
  let remaining = threadLimitBytes;
  for (const message of messages.slice(-messageLimit).reverse()) {
    if (!message || typeof message.id !== "string" || !message.id
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.content !== "string" || !message.content.trim()) continue;
    const metadata = {
      id: message.id,
      role: message.role,
      timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined
    };
    const overhead = Buffer.byteLength(JSON.stringify({ ...metadata, content: "" }), "utf8");
    const content = truncateUtf8(message.content, Math.min(messageLimitBytes - overhead, remaining - overhead));
    if (!content) continue;
    const bounded = { ...metadata, content };
    const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    if (bytes > remaining || bytes > messageLimitBytes) continue;
    remaining -= bytes;
    result.unshift(bounded);
  }
  return result;
}

function truncateUtf8(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > limit) break;
    result += character;
    used += bytes;
  }
  return result;
}

function truncateCharacters(value, limit) {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= limit) break;
    result += character;
    count += 1;
  }
  return result;
}
