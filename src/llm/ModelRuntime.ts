/**
 * 模型控制面：组合 Provider Runtime、模型注册表和当前可执行模型。
 *
 * ProviderRegistry 是模型与服务商行为的来源；ModelRegistry 只负责面向 UI/CLI 的查找和展示。
 */
import type { ModelCatalogEntry } from "../ai/types.js";
import type { AgentConfig, ProviderConfig } from "../config/schema.js";
import { ModelRegistry, type ModelChoice, type RegisteredModel } from "./ModelRegistry.js";
import { ProviderRegistry, type ModelSettings, type ProviderCredentialPersistence } from "./ProviderRuntime.js";
import { AiRegistry } from "./AiRegistry.js";
import type { ModelsStore } from "./ModelsStore.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";

export class ModelRuntime {
  private readonly providers: ProviderRegistry;
  private readonly models: ModelRegistry;

  constructor(
    private readonly config: AgentConfig,
    catalogs: readonly [string, ModelCatalogEntry[]][] = [],
    ai: AiRegistry = new AiRegistry(),
    modelsStore?: ModelsStore,
    fetcher: typeof globalThis.fetch = createProxyAwareFetch(),
    credentials?: ProviderCredentialPersistence
  ) {
    this.providers = new ProviderRegistry(config, catalogs, ai, modelsStore, fetcher, credentials);
    this.models = new ModelRegistry(config, this.providers);
    for (const [providerAlias] of Object.entries(config.providers)) {
      this.models.registerCatalog(providerAlias, this.providers.require(providerAlias).getModels());
    }
  }

  listModels(): ModelChoice[] {
    return this.models.listModels();
  }

  resolve(reference: string, options: { requireAvailable?: boolean } = {}): RegisteredModel {
    const normalized = reference.trim();
    if (!normalized) throw new Error("Model reference cannot be empty.");
    const resolved = this.models.resolve(normalized);
    if (!resolved) throw new Error(`Unknown model "${normalized}". Use a configured alias or provider/model-id.`);
    if (options.requireAvailable && !this.models.isAvailable(resolved)) {
      throw new Error(`Model "${normalized}" is not available: configure its endpoint and credentials first.`);
    }
    return resolved;
  }

  createModelSettings(alias = this.config.defaultModel): ModelSettings {
    return this.providers.createModelSettings(alias);
  }

  validate(alias = this.config.defaultModel): void {
    this.providers.validate(alias);
  }

  async refreshModels(providerAlias: string, signal?: AbortSignal, force = false): Promise<ModelCatalogEntry[]> {
    const entries = await this.providers.refreshModels(providerAlias, signal, force);
    this.models.registerCatalog(providerAlias, entries);
    return entries;
  }

  async refreshActiveCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined> {
    const resolved = this.resolve(this.config.defaultModel);
    return await this.providers.require(resolved.providerAlias).refreshCredential(signal);
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return this.providers.catalogsSnapshot();
  }
}
