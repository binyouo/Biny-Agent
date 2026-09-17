/**
 * Provider 模型工厂。
 *
 * 配置模型统一由 ProviderRuntime 解析成 Vercel AI SDK model；这里仅保留
 * 需要独立配置快照时的装配入口，不实现任何 provider 协议。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig } from "../config/schema.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";
import { ProviderRegistry, type ModelSettings } from "./ProviderRuntime.js";

export type { ModelSettings } from "./ProviderRuntime.js";

export function createModelForConfig(config: AgentConfig, alias = config.defaultModel): AgentModel {
  return createModelSettings(config, alias).model;
}

export function createModelSettings(
  config: AgentConfig,
  alias = config.defaultModel,
  fetcher: typeof globalThis.fetch = createProxyAwareFetch()
): ModelSettings {
  return new ProviderRegistry(config, [], undefined, undefined, fetcher).createModelSettings(alias);
}

export function validateModelConfiguration(config: AgentConfig, alias = config.defaultModel): void {
  new ProviderRegistry(config).validate(alias);
}
