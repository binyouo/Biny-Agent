/**
 * 受管 Plugin 的用户配置（biny-plugin.json 声明 + 受管清单内存储值）。
 *
 * biny-plugin.json 随 Plugin 一起下载，只声明可编辑项与默认值；用户提交的值保存在
 * 受管清单的 settings 字段里，加载时与声明默认值合并成 context.settings。
 * 形状校验集中在本模块，安装与 IPC 边界只传递 unknown。
 */
import { z } from "zod";

export const PLUGIN_PACKAGE_FILE = "biny-plugin.json";

const settingKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);
const maxStringSettingLength = 2_000;
const settingTitleSchema = z.string().trim().min(1).max(80);
const settingDescriptionSchema = z.string().trim().max(500);

const pluginSettingPropertySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("boolean"),
    title: settingTitleSchema.optional(),
    description: settingDescriptionSchema.optional(),
    default: z.boolean().optional()
  }).strict(),
  z.object({
    type: z.literal("string"),
    title: settingTitleSchema.optional(),
    description: settingDescriptionSchema.optional(),
    default: z.string().max(maxStringSettingLength).optional(),
    enum: z.array(z.string().min(1).max(200)).min(1).max(64).optional()
  }).strict(),
  z.object({
    type: z.literal("number"),
    title: settingTitleSchema.optional(),
    description: settingDescriptionSchema.optional(),
    default: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional()
  }).strict()
]).superRefine((property, context) => {
  if (property.type === "string") {
    if (property.enum !== undefined && new Set(property.enum).size !== property.enum.length) {
      context.addIssue({ code: "custom", path: ["enum"], message: "enum 选项不能重复。" });
    }
    if (property.default !== undefined && property.enum !== undefined && !property.enum.includes(property.default)) {
      context.addIssue({ code: "custom", path: ["default"], message: "默认值必须属于 enum 选项。" });
    }
  }
  if (property.type === "number") {
    if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) {
      context.addIssue({ code: "custom", path: ["minimum"], message: "minimum 不能大于 maximum。" });
    }
    if (property.default !== undefined
      && ((property.minimum !== undefined && property.default < property.minimum)
        || (property.maximum !== undefined && property.default > property.maximum))) {
      context.addIssue({ code: "custom", path: ["default"], message: "默认值必须在 minimum 与 maximum 之间。" });
    }
  }
});

export const pluginConfigurationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  properties: z.record(settingKeySchema, pluginSettingPropertySchema)
}).strict().refine((configuration) => {
  const count = Object.keys(configuration.properties).length;
  return count >= 1 && count <= 32;
}, "Plugin 可配置项数量必须在 1 到 32 之间。");

export const pluginSettingValueSchema = z.union([
  z.boolean(),
  z.string().max(maxStringSettingLength),
  z.number().finite()
]);
export const pluginSettingsSchema = z.record(settingKeySchema, pluginSettingValueSchema);
export const pluginPackageSchema = z.object({
  configuration: pluginConfigurationSchema.optional()
}).strict();

export type PluginConfiguration = z.infer<typeof pluginConfigurationSchema>;
export type PluginSettingProperty = PluginConfiguration["properties"][string];
export type PluginSettingValue = z.infer<typeof pluginSettingValueSchema>;
export type PluginSettings = Record<string, PluginSettingValue>;

/** 值是否满足单个声明项的类型与取值范围约束。 */
function declaredValueValid(property: PluginSettingProperty, value: PluginSettingValue): boolean {
  switch (property.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && (property.enum === undefined || property.enum.includes(value));
    case "number":
      return typeof value === "number"
        && (property.minimum === undefined || value >= property.minimum)
        && (property.maximum === undefined || value <= property.maximum);
  }
}

/** 写边界：逐项校验用户提交的值，拒绝未声明、类型不符或越界的项。 */
export function parsePluginSettings(configuration: PluginConfiguration, values: unknown): PluginSettings {
  const parsed = pluginSettingsSchema.parse(values);
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(configuration.properties, key)) throw new Error(`Plugin 设置项未声明：${key}`);
    if (!declaredValueValid(configuration.properties[key]!, value)) throw new Error(`Plugin 设置值无效：${key}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/** 安装/更新迁移：只保留仍被声明且仍合法的旧值；没有可保留项时返回 undefined。 */
export function retainPluginSettings(
  configuration: PluginConfiguration | undefined,
  previous: PluginSettings | undefined
): PluginSettings | undefined {
  if (configuration === undefined || previous === undefined) return undefined;
  const retained = Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
    Object.hasOwn(configuration.properties, key) && declaredValueValid(configuration.properties[key]!, value)
  ));
  return Object.keys(retained).length === 0 ? undefined : retained;
}

/** 加载：按声明顺序合并存储值与默认值；两者都缺省时不输出该项。 */
export function resolvePluginSettings(
  configuration: PluginConfiguration | undefined,
  stored: PluginSettings | undefined
): PluginSettings {
  if (configuration === undefined) return {};
  const resolved: PluginSettings = {};
  for (const [key, property] of Object.entries(configuration.properties)) {
    const value = stored !== undefined && Object.hasOwn(stored, key) ? stored[key] : property.default;
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}
