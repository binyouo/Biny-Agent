/**
 * 品牌图标数据加载器。
 *
 * 图标集约 480KB，使用独立 chunk 按需加载，避免增加主包体积。
 * 这里同样用动态 import，并在模块级缓存，避免每次打开选择器都重新解析一份。
 */
import type { ProviderIconEntry, ProviderIconGlyph } from "../assets/provider-icon-data.js";

export interface ProviderIconData {
  data: Record<string, ProviderIconGlyph>;
  list: ProviderIconEntry[];
}

let cache: ProviderIconData | null = null;
let pending: Promise<ProviderIconData> | null = null;

export function loadProviderIconData(): Promise<ProviderIconData> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = import("../assets/provider-icon-data.js").then((loaded) => {
      cache = { data: loaded.PROVIDER_ICON_DATA, list: loaded.PROVIDER_ICON_LIST };
      return cache;
    });
  }
  return pending;
}

/** 已加载的数据；未加载时返回 null。供同步初始化用，避免先闪一下兜底字形。 */
export function getCachedProviderIconData(): ProviderIconData | null {
  return cache;
}

/** 仅测试用：清空缓存，让下一次调用重新走动态 import。 */
export function resetProviderIconDataCache(): void {
  cache = null;
  pending = null;
}
