import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { resolveProviderIconId } from "../../providerIconIds.js";

export interface SettingsModelPickerOption {
  value: string;
  label: string;
  secondary?: string;
  disabled?: boolean;
}

/**
 * 服务商连接里参与图标解析的那一小部分。
 *
 * 设置快照里的 `DesktopModelConnection` 结构上满足它 —— 这里只声明用得上的两个字段，
 * 免得渲染层的数据模块反向依赖桌面端协议。
 */
export interface SettingsModelPickerConnection {
  providerAlias: string;
  /** 用户为该服务商挑的品牌图标 id；没覆盖过则缺省。 */
  icon?: string;
}

export interface SettingsModelPickerGroup {
  key: string;
  label: string;
  iconTone: string;
  /** 目录自带品牌图标的 id；没有就留给手写字形兜底。 */
  iconId?: string;
  options: SettingsModelPickerOption[];
}

export function modelPickerGroups(
  models: readonly ModelChoice[],
  connections: readonly SettingsModelPickerConnection[] = []
): SettingsModelPickerGroup[] {
  const groups = new Map<string, SettingsModelPickerGroup>();
  // 自定义服务商没有自带品牌图标，只能靠用户在创建时挑的那个 —— 它存在**连接**上，
  // 而不是模型上，所以要按 providerAlias 反查一次。
  const iconByAlias = new Map(connections.map((connection) => [connection.providerAlias, connection.icon]));
  for (const model of models) {
    if (model.showInPicker === false) continue;
    const presentation = modelProviderPresentation(model, iconByAlias.get(model.provider));
    const key = `${model.providerType}:${model.provider}:${model.baseUrl ?? ""}`;
    const group = groups.get(key) ?? {
      key,
      label: presentation.label,
      iconTone: presentation.iconTone,
      iconId: presentation.iconId,
      options: []
    };
    group.options.push({
      value: model.alias,
      label: model.displayName,
      secondary: model.model !== model.displayName ? model.model : model.alias
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function modelProviderPresentation(
  model: Pick<ModelChoice, "provider" | "providerType" | "baseUrl">,
  connectionIcon: string | undefined
): { label: string; iconTone: string; iconId?: string } {
  const catalog = catalogForConnection({ provider: model.provider, providerType: model.providerType }, model.baseUrl);
  return {
    label: catalog?.label ?? model.provider,
    iconTone: catalog?.iconTone ?? model.providerType,
    // 内置目录服务商一律用自带品牌图标（见 providerIconIds.ts）；自定义服务商才回落到用户挑的。
    iconId: resolveProviderIconId(connectionIcon, catalog?.id)
  };
}
