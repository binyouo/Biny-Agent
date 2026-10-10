/** Agent 回合的工具与 Skill 选择协议。
 *
 * `auto` 在回合准备时交给辅助模型筛选，`all` 显式暴露全部已注册能力；数组表示
 * 本次消息的自定义选择。设置页只保存默认模式，具体数组只随当前消息传递，不写入会话配置。
 */
import { z } from "zod";
export const capabilitySelectionModeSchema = z.enum(["auto", "all", "none"]);
const capabilityNamesSchema = z.array(z.string().trim().min(1).max(240));
const customCapabilityNamesSchema = capabilityNamesSchema.max(512);
export const capabilitySelectionValueSchema = z.union([capabilitySelectionModeSchema, customCapabilityNamesSchema]);
export const agentCapabilitySelectionSchema = z.object({
  tools: capabilitySelectionValueSchema,
  skills: capabilitySelectionValueSchema
}).strict();

/** 会话累计结果可超过单次手选上限，名称与模式校验仍保持一致。 */
export const resolvedCapabilitySelectionSchema = agentCapabilitySelectionSchema.extend({
  tools: z.union([capabilitySelectionModeSchema, capabilityNamesSchema])
});

export type CapabilitySelectionMode = z.infer<typeof capabilitySelectionModeSchema>;
export type CapabilitySelectionValue = z.infer<typeof capabilitySelectionValueSchema>;
export type AgentCapabilitySelection = z.infer<typeof agentCapabilitySelectionSchema>;

/** 将设置默认值或本次消息的选择解析成工具名称白名单；auto/all 返回 undefined 表示不裁剪。 */
export function resolveCapabilityNames(
  selection: CapabilitySelectionValue | undefined,
  defaultSelection: CapabilitySelectionMode = "auto",
  availableNames: readonly string[]
): ReadonlySet<string> | undefined {
  const chosen = selection ?? defaultSelection;
  if (chosen === "auto" || chosen === "all") return undefined;
  if (chosen === "none") return new Set();
  const available = new Set(availableNames);
  return new Set(chosen.filter((name) => available.has(name)));
}
