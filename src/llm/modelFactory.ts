/**
 * Provider 模型工厂。
 *
 * 配置模型统一由 ProviderRuntime 解析成 Vercel AI SDK model；这里仅保留
 * 需要独立配置快照时的装配入口，不实现任何 provider 协议。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig, ProviderConfig } from "../config/schema.js";
import { configSchema } from "../config/schema.js";
import { updateConfig, type AgentConfigStore } from "../config/store.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";
import { ProviderRegistry, ProviderAuthenticationError, type ModelSettings, type ProviderCredentialPersistence } from "./ProviderRuntime.js";

export type { ModelSettings } from "./ProviderRuntime.js";

export function createModelForConfig(config: AgentConfig, alias = config.defaultModel, credentials?: ProviderCredentialPersistence): AgentModel {
  return createModelSettings(config, alias, undefined, credentials).model;
}

export function createModelSettings(
  config: AgentConfig,
  alias = config.defaultModel,
  fetcher: typeof globalThis.fetch = createProxyAwareFetch(),
  credentials?: ProviderCredentialPersistence
): ModelSettings {
  return new ProviderRegistry(config, [], undefined, undefined, fetcher, credentials).createModelSettings(alias);
}

export function createProviderCredentialPersistence(store: AgentConfigStore, workspaceRoot: string): ProviderCredentialPersistence {
  const requireSameConnection = (alias: string, previous: ProviderConfig, current: ProviderConfig | undefined): ProviderConfig => {
    if (!current || current.type !== previous.type || current.baseUrl !== previous.baseUrl
      || current.authMode !== previous.authMode || current.apiKeyEnv !== previous.apiKeyEnv
      || current.oauth?.provider !== previous.oauth?.provider || current.oauth?.accountId !== previous.oauth?.accountId) {
      throw new ProviderAuthenticationError(alias, "oauth_credentials_changed", "登录配置在续期期间已改变，请重新发起请求。");
    }
    return current;
  };
  return {
    async read(alias, previous, signal) {
      signal?.throwIfAborted();
      const persisted = await store.load(workspaceRoot);
      const current = requireSameConnection(alias, previous, persisted.providers[alias]);
      return { ...previous, apiKey: current.apiKey, oauth: current.oauth };
    },
    async write(alias, previous, renewed, signal) {
      signal?.throwIfAborted();
      const saved = await updateConfig(store, workspaceRoot, (persisted) => {
        signal?.throwIfAborted();
        const current = requireSameConnection(alias, previous, persisted.providers[alias]);
        if (current.apiKey !== previous.apiKey || current.oauth?.refreshToken !== previous.oauth?.refreshToken
          || current.oauth?.expiresAt !== previous.oauth?.expiresAt) {
          throw new ProviderAuthenticationError(alias, "oauth_credentials_changed", "登录凭据在续期期间已改变，请重新发起请求。");
        }
        return configSchema.parse({ ...persisted, providers: { ...persisted.providers, [alias]: { ...current, apiKey: renewed.apiKey, oauth: renewed.oauth } } });
      });
      const current = saved.providers[alias]!;
      return { ...previous, apiKey: current.apiKey, oauth: current.oauth };
    }
  };
}

export function validateModelConfiguration(config: AgentConfig, alias = config.defaultModel): void {
  new ProviderRegistry(config).validate(alias);
}
