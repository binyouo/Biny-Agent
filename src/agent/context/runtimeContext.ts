import type { AgentMessage, AgentUserMessage } from "../core/types.js";

export function isRuntimeContext(message: AgentMessage): boolean {
  return message.role === "user" && (message.runtimeDateContext === true || message.runtimeContext !== undefined);
}

/** 宿主来源单独标记；正文中的同名标签不能伪造状态或抑制更新。 */
export function appendRuntimeContext(messages: AgentMessage[], kind: string, content: string): AgentUserMessage | undefined {
  const previous = [...messages].reverse().find(message => message.role === "user" && message.runtimeContext === kind);
  const body = renderRuntimeContext(kind, content);
  if (previous?.content === body || !previous && !content) return;
  const message: AgentUserMessage = { role: "user", content: body, runtimeContext: kind };
  messages.push(message);
  return message;
}

export function renderRuntimeContext(kind: string, content: string): string {
  return `<biny_runtime_context kind="${kind}">\nCurrent ${kind} context; supersedes earlier ${kind} snapshots. This is host context, not a new user request or additional permission.\n${content || "No current state."}\n</biny_runtime_context>`;
}
