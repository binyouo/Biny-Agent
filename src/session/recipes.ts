/**
 * 从已完成的会话事实中识别可复用 Recipe。
 *
 * 这里不调用模型，也不创建 Skill 或任务。Recipe 只描述“这条会话已经具备哪些
 * 可复用材料”，状态单独落在持久化目录；用户点击提取后，真正的创建动作仍由下一
 * 次普通消息完成。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "./recorder.js";
import { redactSecrets } from "../utils/secrets.js";

export const recipeIds = ["repeatable-doc-task", "mcp-pipeline", "thread-to-workflow"] as const;
export type RecipeId = (typeof recipeIds)[number];
export type RecipeState = "notified" | "dismissed" | "extracted";
export type RecipeStateMap = Partial<Record<RecipeId, RecipeState>>;

export interface RecipeSlot {
  key: string;
  label: string;
  filled: boolean;
}

export interface RecipeSuggestion {
  id: RecipeId;
  title: string;
  description: string;
  slots: RecipeSlot[];
  extractPrompt: string;
}

interface RecipeFacts {
  userTurns: number;
  toolNames: Set<string>;
  mcpToolNames: Set<string>;
  filesWritten: string[];
  attachments: string[];
  hasFileReference: boolean;
  corrections: number;
  userAnchors: Array<{ messageId?: string; text: string }>;
}

const correctionPattern = /(不对|不是|重新|再改|改成|应该是|换成|按照|注意|修正|错了|not right|instead|actually|redo|change it|should be)/iu;
const fileReferencePattern = /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|html)/giu;
const maxAnchorTextLength = 30;

export class RecipeStateStore {
  private readonly root: string;

  constructor(persistenceRoot: string) {
    this.root = path.join(path.resolve(persistenceRoot), "recipe-state");
  }

  async read(sessionId: string): Promise<RecipeStateMap> {
    const directory = this.sessionDirectory(sessionId);
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const states: RecipeStateMap = {};
      await Promise.all(entries.filter((entry) => entry.isFile() && recipeIds.includes(entry.name.replace(/\.json$/u, "") as RecipeId)).map(async (entry) => {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8")) as { state?: unknown };
          const recipeId = entry.name.replace(/\.json$/u, "") as RecipeId;
          if (raw.state === "notified" || raw.state === "dismissed" || raw.state === "extracted") states[recipeId] = raw.state;
        } catch {
          // 损坏的单个状态不应让历史会话无法打开；下次通知时会重新覆盖它。
        }
      }));
      return states;
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  async set(sessionId: string, recipeId: RecipeId, state: RecipeState): Promise<void> {
    const directory = this.sessionDirectory(sessionId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${recipeId}.json`);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, state })}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  async clear(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }

  private sessionDirectory(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error("Invalid session id.");
    return path.join(this.root, sessionId);
  }
}

export function freshRecipeSuggestions(
  events: readonly SessionEvent[],
  sessionId: string,
  states: RecipeStateMap = {}
): RecipeSuggestion[] {
  const facts = collectRecipeFacts(events);
  return recipeDefinitions(facts)
    .filter((recipe) => recipe.slots.every((slot) => slot.filled))
    .filter((recipe) => states[recipe.id] === undefined)
    .map((recipe) => ({ ...recipe, extractPrompt: buildRecipePrompt(recipe, sessionId, facts) }));
}

export function openRecipeSuggestions(
  events: readonly SessionEvent[],
  sessionId: string,
  states: RecipeStateMap = {}
): RecipeSuggestion[] {
  const facts = collectRecipeFacts(events);
  return recipeDefinitions(facts)
    .filter((recipe) => recipe.slots.every((slot) => slot.filled))
    .filter((recipe) => states[recipe.id] !== "dismissed" && states[recipe.id] !== "extracted")
    .map((recipe) => ({ ...recipe, extractPrompt: buildRecipePrompt(recipe, sessionId, facts) }));
}

export function collectRecipeFacts(events: readonly SessionEvent[]): RecipeFacts {
  const toolCalls = new Map<string, { tool: string; args: unknown }>();
  const successfulCalls: Array<{ tool: string; args: unknown; result: unknown }> = [];
  const facts: RecipeFacts = {
    userTurns: 0,
    toolNames: new Set(),
    mcpToolNames: new Set(),
    filesWritten: [],
    attachments: [],
    hasFileReference: false,
    corrections: 0,
    userAnchors: []
  };

  for (const event of events) {
    if ("auditOnly" in event && event.auditOnly) continue;
    if (event.type === "user_message") {
      facts.userTurns += 1;
      facts.hasFileReference ||= fileReferencePattern.test(event.content);
      fileReferencePattern.lastIndex = 0;
      if (event.attachments?.length) facts.attachments.push(...event.attachments.map((attachment) => attachment.name));
      if (facts.userAnchors.length < 4) facts.userAnchors.push({ messageId: event.messageId, text: event.content });
      if (facts.userTurns > 1 && correctionPattern.test(event.content)) facts.corrections += 1;
      continue;
    }
    if (event.type === "tool_call") {
      if (event.toolCallId) toolCalls.set(event.toolCallId, { tool: event.tool, args: event.args });
      continue;
    }
    if (event.type !== "tool_result" || !successfulToolResult(event)) continue;
    const call = event.toolCallId ? toolCalls.get(event.toolCallId) : undefined;
    const tool = call?.tool ?? event.tool;
    successfulCalls.push({ tool, args: call?.args, result: event.result });
  }

  for (const call of successfulCalls) {
    const name = call.tool;
    if (isMcpTool(name)) facts.mcpToolNames.add(name);
    else facts.toolNames.add(name);
    if (name === "Write" || name === "Edit") {
      const filePath = stringField(call.args, "path") ?? stringField(call.args, "filePath") ?? stringField(call.result, "path");
      if (filePath && !facts.filesWritten.includes(filePath)) facts.filesWritten.push(filePath);
    }
  }
  return facts;
}

function recipeDefinitions(facts: RecipeFacts): Array<{ id: RecipeId; title: string; description: string; slots: RecipeSlot[] }> {
  return [
    {
      id: "repeatable-doc-task",
      title: "可重复的文档/报表任务",
      description: "输入材料 + 多轮口径修正 + 成功产出 —— 可以提取成一个下次直接运行的任务。",
      slots: [
        { key: "input", label: "输入材料（附件或文件引用）", filled: facts.attachments.length > 0 || facts.hasFileReference },
        { key: "rules", label: "统计/格式口径（修正轮次或规则引用）", filled: facts.corrections >= 2 },
        { key: "toolchain", label: "成功的工具链", filled: facts.toolNames.size > 0 || facts.mcpToolNames.size > 0 },
        { key: "output", label: "最终产出（写出的文件）", filled: facts.filesWritten.length > 0 }
      ]
    },
    {
      id: "mcp-pipeline",
      title: "固定的 MCP 处理流程",
      description: "外部工具（MCP）+ 固定格式产出 —— 可以提取成放入新材料即可复跑的流程。",
      slots: [
        { key: "material", label: "输入材料", filled: facts.attachments.length > 0 || facts.hasFileReference },
        { key: "mcp", label: "成功的 MCP 工具调用", filled: facts.mcpToolNames.size > 0 },
        { key: "output", label: "固定格式产出", filled: facts.filesWritten.length > 0 }
      ]
    },
    {
      id: "thread-to-workflow",
      title: "把这次对话提炼成工作流",
      description: "这条线程已经跑通了一件多步骤的事 —— 可以提炼成技能或工作流，下次一句话复用。",
      slots: [
        { key: "depth", label: "足够的来回打磨（≥5 个用户回合）", filled: facts.userTurns >= 5 },
        { key: "work", label: "实际产出（文件或多种工具）", filled: facts.filesWritten.length > 0 || facts.toolNames.size + facts.mcpToolNames.size >= 3 },
        { key: "materials", label: "沉淀的材料（引用过的对象）", filled: facts.attachments.length > 0 || facts.hasFileReference }
      ]
    }
  ];
}

function buildRecipePrompt(
  recipe: { title: string },
  sessionId: string,
  facts: RecipeFacts
): string {
  const lines = [
    `请把这条会话里已经跑通的「${recipe.title}」提取成一个可复用、可追溯的 Biny 对象。`,
    "",
    "材料：",
    `- 当前会话 ID：${sessionId}`
  ];
  for (const anchor of facts.userAnchors) {
    const text = redactSecrets(anchor.text).trim().slice(0, maxAnchorTextLength) || "用户消息";
    lines.push(`- 关键回合${anchor.messageId ? ` [${anchor.messageId}]` : ""}：${text}`);
  }
  if (facts.filesWritten.length) lines.push(`- 产出文件：${facts.filesWritten.slice(0, 5).join(", ")}`);
  if (facts.mcpToolNames.size) lines.push(`- 用到的 MCP 工具：${Array.from(facts.mcpToolNames).slice(0, 6).join(", ")}`);
  if (facts.toolNames.size) lines.push(`- 用到的工具：${Array.from(facts.toolNames).slice(0, 8).join(", ")}`);
  lines.push(
    "",
    "要求：先读取当前会话中上面列出的关键回合，恢复真实口径与流程；选择最合适的形态（Skill / 定时任务 / Agent / 计划模板）并直接创建；名字用中文、贴合任务；创建完成后说明下次如何一句话使用。"
  );
  return lines.join("\n");
}

function successfulToolResult(event: Extract<SessionEvent, { type: "tool_result" }>): boolean {
  if (event.executionStatus !== undefined) return event.executionStatus === "succeeded";
  return !hasToolFailure(event.result);
}

function hasToolFailure(value: unknown, seen = new Set<object>()): boolean {
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (typeof value.error === "string" || value.approved === false || (typeof value.exitCode === "number" && value.exitCode !== 0)) return true;
  if (value.status === "denied" || value.status === "failed" || value.status === "timed_out" || value.status === "aborted" || value.status === "permission_required" || value.status === "cancelled") return true;
  return value.result !== value && hasToolFailure(value.result, seen);
}

function isMcpTool(name: string): boolean {
  return name.startsWith("mcp_");
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
