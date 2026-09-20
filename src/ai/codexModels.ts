/**
 * 订阅 OAuth 访问路径的静态模型目录。
 *
 * 账号接口返回的实时目录优先；这里的目录用于首次登录、接口暂时不可用或
 * 账号目录为空时的离线兜底。模型元数据仍由 modelMetadata.ts 统一补全。
 */
import type { ThinkingLevelMap } from "../config/schema.js";

export interface OpenAiCodexCatalogModel {
  id: string;
  displayName: string;
  contextWindow: number | undefined;
}

/** 订阅访问路径的能力覆盖；通用元数据不能替代订阅入口的真实档位。 */
export const openAiCodexThinkingLevelMaps: Readonly<Record<string, ThinkingLevelMap>> = {
  "gpt-5.6-luna": {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max"
  }
};

export const openAiCodexCatalogModels: readonly OpenAiCodexCatalogModel[] = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextWindow: 372_000 },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", contextWindow: undefined },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", contextWindow: undefined },
  { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272_000 },
  { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272_000 },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", contextWindow: 272_000 },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", contextWindow: undefined },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", contextWindow: undefined }
];
