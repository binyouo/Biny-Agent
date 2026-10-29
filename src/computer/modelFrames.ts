import type { AgentMessage } from "../agent/core/types.js";
import { maxComputerImageBytes } from "./protocol.js";
/** Retain at most two recent observation frames (2 MiB) in each actual model request. */
export function boundComputerFrames(messages: AgentMessage[]): AgentMessage[] {
  let remaining = 2; let bytes = 0;
  return [...messages].reverse().map((message): AgentMessage => {
    if (message.role !== "toolResult" || !(["ComputerObserve", "ComputerAction", "BrowserScreenshot", "BrowserClipboardRead", "ChromeRelayScreenshot"].includes(message.toolName) || message.toolName.startsWith("mcp_computer-use_"))) return message;
    const content = [...message.content].reverse().map(part => {
      if (part.type !== "image") return part;
      const size = Buffer.byteLength(part.data, "base64");
      if (remaining > 0 && size <= maxComputerImageBytes && bytes + size <= 2 * maxComputerImageBytes) { remaining--; bytes += size; return part; }
      return { type: "text" as const, text: "[Older observation frame retired; use a fresh observation before acting.]" };
    }).reverse();
    return { ...message, content };
  }).reverse();
}
