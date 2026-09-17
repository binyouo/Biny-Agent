/**
 * 进程内 AI 扩展注册表。
 *
 * 每个 CommandRuntime 持有独立实例，插件只影响当前工作区。Provider 定义、离线模型目录和
 * 凭据处理通过同一对象交给 ModelManager，避免依赖全局可变状态。
 */
import { createBuiltinProviderRegistry, type ProviderDefinitionRegistry } from "../ai/provider.js";
import type { ModelCatalogEntry, ProviderDefinition } from "../ai/types.js";
import type { ProviderConfig } from "../config/schema.js";

export type CredentialRefreshHandler = (config: ProviderConfig, signal?: AbortSignal) => Promise<ProviderConfig>;

export class AiRegistry {
  readonly providers: ProviderDefinitionRegistry;
  private readonly credentialHandlers = new Map<string, CredentialRefreshHandler>();

  constructor(providers: ProviderDefinitionRegistry = createBuiltinProviderRegistry()) {
    this.providers = providers;
  }

  registerProvider(definition: ProviderDefinition, models: readonly ModelCatalogEntry[] = []): void {
    this.providers.register(definition, models);
  }

  registerCredentialHandler(id: string, handler: CredentialRefreshHandler): void {
    this.credentialHandlers.set(id, handler);
  }

  credentialHandler(id: string): CredentialRefreshHandler | undefined {
    return this.credentialHandlers.get(id);
  }

  registerModels(providerType: string, models: readonly ModelCatalogEntry[]): void {
    const registration = this.providers.get(providerType);
    if (!registration) throw new Error(`Register provider ${providerType} before registering its models.`);
    const combined = new Map(registration.models.map((model) => [model.id, model]));
    for (const model of models) combined.set(model.id, { ...model });
    this.providers.register(registration.definition, [...combined.values()]);
  }

  clone(): AiRegistry {
    const cloned = new AiRegistry(this.providers.clone());
    for (const [id, handler] of this.credentialHandlers) cloned.registerCredentialHandler(id, handler);
    return cloned;
  }
}
