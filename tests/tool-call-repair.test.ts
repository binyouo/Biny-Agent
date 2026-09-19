/** 工具调用自愈：名字或参数不合法的调用在执行前修复，可修复失败不再进入「报错→原样重试」循环。 */
import assert from "node:assert/strict";
import { generateText, InvalidToolInputError, jsonSchema, NoSuchToolError, tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { JSONSchema7, LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { toolCallRepair } from "../src/agent/core/toolCallRepair.js";

const schemas: Record<string, JSONSchema7> = {
  Read: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      lineCount: { type: "integer", minimum: 1 }
    },
    required: ["path"],
    additionalProperties: false
  },
  Bash: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 1 }
    },
    required: ["command"],
    additionalProperties: false
  },
  Edit: {
    type: "object",
    properties: {
      path: { type: "string" },
      operation: { type: "string", enum: ["update", "delete", "move"] },
      replace_all: { type: "boolean" },
      old_string: { type: "string" },
      new_string: { type: "string" }
    },
    additionalProperties: false
  },
  ToolSearch: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      type: { type: "string", enum: ["builtin", "mcp", "skill", "plugin", "subagent", "all"] },
      maxResults: { type: "integer", minimum: 1 }
    },
    required: ["query"],
    additionalProperties: false
  }
};

async function repair(toolName: string, input: string, error: unknown): Promise<LanguageModelV4ToolCall | null> {
  const tools = Object.fromEntries(Object.keys(schemas).map((name) => [name, {}])) as unknown as ToolSet;
  return await toolCallRepair({
    instructions: undefined,
    system: undefined,
    messages: [],
    toolCall: { type: "tool-call", toolCallId: "call-1", toolName, input },
    tools,
    inputSchema: async ({ toolName: name }) => schemas[name] ?? {},
    error
  });
}

// 名字修复：仅归一化匹配（大小写/分隔符变体）；已移除的历史工具名不复活。
const normalized = await repair("BASH", '{"command":"ls"}', new NoSuchToolError({ toolName: "BASH" }));
assert.equal(normalized?.toolName, "Bash");

const underscored = await repair("tool_search", '{"query":"files"}', new NoSuchToolError({ toolName: "tool_search" }));
assert.equal(underscored?.toolName, "ToolSearch");

assert.equal(
  await repair("write_file", "{}", new NoSuchToolError({ toolName: "write_file" })),
  null,
  "已移除的历史工具名必须保持拒绝，不做语义别名"
);

assert.equal(
  await repair("shell", '{"cmd":"ls"}', new NoSuchToolError({ toolName: "shell" })),
  null,
  "语义别名会绕过工具集治理，不在名字层修复"
);

assert.equal(
  await repair("nonexistent_tool", "{}", new NoSuchToolError({ toolName: "nonexistent_tool" })),
  null,
  "目录里没有近似名字时应放弃修复"
);

// 参数修复：合法名字 + 非法参数。
const inputError = (toolName: string, input: string) => new InvalidToolInputError({ toolName, toolInput: input, cause: new Error("schema") });
const paramRenamed = await repair("Read", '{"filepath":"notes.md"}', inputError("Read", '{"filepath":"notes.md"}'));
assert.equal(paramRenamed?.toolName, "Read");
assert.deepEqual(JSON.parse(paramRenamed?.input ?? ""), { path: "notes.md" });

const numericCoerced = await repair("Bash", '{"command":"ls","timeoutMs":"3000"}', inputError("Bash", '{"command":"ls","timeoutMs":"3000"}'));
assert.deepEqual(JSON.parse(numericCoerced?.input ?? ""), { command: "ls", timeoutMs: 3000 });

const booleanCoerced = await repair("Edit", '{"path":"a","old_string":"x","new_string":"y","replace_all":"true"}', inputError("Edit", '{"path":"a","old_string":"x","new_string":"y","replace_all":"true"}'));
assert.deepEqual(JSON.parse(booleanCoerced?.input ?? ""), { path: "a", old_string: "x", new_string: "y", replace_all: true });

const enumFixed = await repair("Edit", '{"path":"a","operation":"Update","old_string":"x","new_string":"y"}', inputError("Edit", '{"path":"a","operation":"Update","old_string":"x","new_string":"y"}'));
assert.deepEqual(JSON.parse(enumFixed?.input ?? ""), { path: "a", operation: "update", old_string: "x", new_string: "y" });

const unmappedDropped = await repair("Read", '{"path":"notes.md","bogus":1}', inputError("Read", '{"path":"notes.md","bogus":1}'));
assert.deepEqual(JSON.parse(unmappedDropped?.input ?? ""), { path: "notes.md" });

// 无法恢复的字符串参数且名字未变时放弃修复；名字归一化修复仍可单独成立并回退为空对象参数。
assert.equal(await repair("Read", "not json", inputError("Read", "not json")), null);
const renamedOnly = await repair("BASH", "not json", new NoSuchToolError({ toolName: "BASH" }));
assert.equal(renamedOnly?.toolName, "Bash");
assert.deepEqual(JSON.parse(renamedOnly?.input ?? "{}"), {});

// 无需修复的调用返回 null，避免无谓重建。
assert.equal(await repair("Read", '{"path":"notes.md"}', inputError("Read", '{"path":"notes.md"}')), null);

// SDK 契约：模型发出大小写变体名字和错误参数的工具调用，经 repairToolCall 后按正确工具执行。
const executed: Array<Record<string, unknown>> = [];
const result = await generateText({
  model: new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        input: JSON.stringify({ file_path: "notes.md" })
      }],
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 }
      },
      warnings: []
    })
  }),
  prompt: "read the notes",
  tools: {
    Read: tool({
      inputSchema: jsonSchema(schemas.Read!),
      execute: async (input) => {
        executed.push(input as Record<string, unknown>);
        return "ok";
      }
    })
  },
  repairToolCall: toolCallRepair
});

assert.deepEqual(executed, [{ path: "notes.md" }]);
assert.equal(result.toolCalls[0]?.toolName, "Read");
assert.equal(result.steps[0]?.content.some((part) => part.type === "tool-result"), true, "修复后的调用应产生正常工具结果而非错误");

console.log("tool call repair tests passed");
