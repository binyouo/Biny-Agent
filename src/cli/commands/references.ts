/** ref CLI 只做参数与输出转换；对象验证和读取统一走本地引用库。 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { globalAgentDir } from "../../config/paths.js";
import { LocalReferenceGraph, LocalReferenceService, formatLocalReference, localReferenceContext, localReferenceProjectId, type LocalReferenceKind } from "../../session/localReferences.js";
import { readSessionEvents } from "../../session/events.js";
import { activeSessionEventsForPath } from "../../session/messageTree.js";
import { resolveSessionFile } from "../../session/store.js";
import { runtimeReferenceEntries } from "../../session/runtimeReferenceEntries.js";
import { connectRuntimeHost } from "../../runtime/RuntimeHost.js";

const aliases: Record<string, LocalReferenceKind> = {
  date: "date", 日期: "date", project: "project", 项目: "project", file: "file", 文件: "file",
  thread: "thread", 会话: "thread", message: "message", 消息: "message", memory: "memory", 记忆: "memory",
  snippet: "snippet", 片段: "snippet", scratch: "scratch", 临时引用: "scratch",
  skill: "skill", 技能: "skill", agent: "agent", 子代理: "agent", 智能体: "agent", mcp: "mcp", model: "model", 模型: "model", provider: "provider", 服务商: "provider",
  tool: "tool", 工具: "tool", "tool-call": "tool-call", 工具调用: "tool-call", task: "task", 任务: "task", cron: "cron", 定时任务: "cron",
  crystal: "crystal", 结晶: "crystal", bundle: "bundle", 结晶包: "bundle", mission: "mission", 目标: "mission", plan: "plan", 计划: "plan"
};

function service(workspaceRoot: string): { instance: LocalReferenceService; projectId: string } {
  const projectPath = path.resolve(workspaceRoot);
  const projectId = localReferenceProjectId(projectPath);
  return { projectId, instance: new LocalReferenceService({ root: globalAgentDir(),
    projects: [{ id: projectId, path: projectPath, name: path.basename(projectPath) }],
    runtimeEntries: async () => {
      const client = await connectRuntimeHost(projectPath);
      if (!client) return [];
      try {
        const [tasks, automations, goals, graphs, tools] = await Promise.all([
          client.taskList(), client.automationList(), client.goalList(), client.graphList(), client.listTools()
        ]);
        return runtimeReferenceEntries({ tasks, automations, goals, graphs }, tools);
      } finally { await client.close(); }
    } }) };
}

export async function referenceKindsCommand(workspaceRoot: string, options: { json?: boolean }): Promise<void> {
  const kinds = service(workspaceRoot).instance.kinds();
  console.log(options.json ? JSON.stringify(kinds) : kinds.map((item) => `${item.kind}\t${item.label}`).join("\n"));
}

export async function referenceSearchCommand(workspaceRoot: string, query: string,
  options: { json?: boolean; kind?: string; limit?: number }): Promise<void> {
  if (options.kind !== undefined && aliases[options.kind] === undefined) throw new Error("Unknown reference kind.");
  const { instance, projectId } = service(workspaceRoot);
  const results = await instance.search(query, projectId, options.kind === undefined ? undefined : aliases[options.kind], options.limit);
  console.log(options.json ? JSON.stringify(results) : results.map((item) => `${item.label}\t${item.uri}`).join("\n"));
}

export async function referenceResolveCommand(workspaceRoot: string, uri: string, options: { json?: boolean }): Promise<void> {
  const { instance, projectId } = service(workspaceRoot);
  const result = await instance.resolve(uri, projectId);
  console.log(options.json ? JSON.stringify(result) : result.content);
}

export async function referenceTokenCommand(workspaceRoot: string, uri: string, label?: string): Promise<void> {
  const { instance, projectId } = service(workspaceRoot);
  const result = await instance.resolve(uri, projectId);
  console.log(formatLocalReference(label ?? result.label, result.uri));
}

export async function referenceContextCommand(workspaceRoot: string, input: string | undefined,
  options: { thread?: string; json?: boolean }): Promise<void> {
  if ((input === undefined) === (options.thread === undefined)) throw new Error("Provide text or --thread.");
  let text = input;
  if (options.thread !== undefined) {
    const file = await resolveSessionFile(workspaceRoot, options.thread);
    const events = activeSessionEventsForPath(await readSessionEvents(file));
    const latest = [...events].reverse().find((event) => event.type === "user_message" && !event.auditOnly);
    text = latest?.type === "user_message" ? latest.content : undefined;
    if (!text) throw new Error("Thread has no active user message.");
  }
  const { instance, projectId } = service(workspaceRoot);
  const context = await localReferenceContext(text!, instance, projectId);
  console.log(options.json ? JSON.stringify({ context }) : context);
}

export async function referenceOpenCommand(workspaceRoot: string, uri: string, options: {
  platform?: NodeJS.Platform; launch?: (command: string, args: string[]) => Promise<void>
} = {}): Promise<void> {
  const { instance, projectId } = service(workspaceRoot);
  const result = await instance.resolve(uri, projectId);
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Desktop reference opening is available on macOS.");
  const launch = options.launch ?? (async (command: string, args: string[]) => { await promisify(execFile)(command, args); });
  await launch("open", ["-n", "-a", "Biny", "--args", `--biny-ref=${result.uri}`, `--biny-project=${projectId}`]);
}

export async function referenceGraphCommand(workspaceRoot: string,
  action: "link" | "unlink" | "backlinks" | "outlinks" | "related" | "graph" | "snippet" | "scratch" | "promote" | "pin" | "unpin" | "pins",
  first: string | undefined, second: string | undefined,
  options: { json?: boolean; start?: number; end?: number; ttlMs?: number } = {}): Promise<void> {
  const { instance, projectId } = service(workspaceRoot);
  const graph = new LocalReferenceGraph(globalAgentDir(), instance);
  try {
    const uri = first ?? "";
    let result: unknown;
    switch (action) {
      case "link": result = { linked: await graph.link(uri, second ?? "", projectId) }; break;
      case "unlink": result = { unlinked: await graph.unlink(uri, second ?? "", projectId) }; break;
      case "backlinks": result = await graph.backlinks(uri, projectId); break;
      case "outlinks": result = await graph.outlinks(uri, projectId); break;
      case "related": result = await graph.related(uri, projectId); break;
      case "graph": result = await graph.graph(uri, projectId); break;
      case "snippet": result = await graph.captureSnippet(uri, options.start ?? -1, options.end ?? -1, projectId); break;
      case "scratch": result = await graph.createScratch(uri, projectId, new Date(), options.ttlMs); break;
      case "promote": result = { promoted: await graph.promoteScratch(uri, projectId) }; break;
      case "pin": result = { pinned: await graph.pin(uri, projectId) }; break;
      case "unpin": result = { unpinned: graph.unpin(uri, projectId) }; break;
      case "pins": result = await graph.pins(projectId); break;
    }
    console.log(options.json ? JSON.stringify(result) : typeof result === "object" && result !== null && "content" in result
      ? String(result.content) : JSON.stringify(result, null, 2));
  } finally { graph.close(); }
}
