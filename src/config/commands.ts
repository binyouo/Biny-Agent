import { z } from "zod";
import { configSchema, type AgentConfig } from "./schema.js";
import { globalConfigDir } from "./paths.js";
import { readSetting, writeSetting } from "./settingPath.js";
import { updateConfig, type AgentConfigStore } from "./store.js";
import { FileModelsStore, restoreProviderCatalogs } from "../llm/ModelsStore.js";
import { listModelChoices, saveModelSelection } from "../llm/ModelManager.js";
import { redactSensitiveValue } from "../utils/secrets.js";

export async function executeConfigurationCommand(store: AgentConfigStore, action: string, input: Record<string, unknown>, configRoot = globalConfigDir()): Promise<unknown> {
  switch (action) {
    case "config.get": return readSetting(redactConfigurationOutput(await store.load(configRoot)), z.string().optional().parse(input.path));
    case "config.set": {
      const key = z.string().parse(input.path);
      const saved = await updateConfig(store, configRoot, current => {
        const next = configSchema.parse(writeSetting(current, key, input.value));
        readSetting(next, key);
        return next;
      });
      return { path: key, value: readSetting(redactConfigurationOutput(saved), key) };
    }
    case "provider.list": return { providers: redactSensitiveValue((await store.load(configRoot)).providers) };
    case "provider.add": {
      const alias = z.string().min(1).parse(input.alias);
      const saved = await updateConfig(store, configRoot, current => {
        if (Object.hasOwn(current.providers, alias)) throw new Error(`Provider already exists: ${alias}`);
        return configSchema.parse({ ...current, providers: { ...current.providers, [alias]: input.definition } });
      });
      return { alias, provider: redactSensitiveValue(saved.providers[alias]) };
    }
    case "provider.remove": {
      const alias = z.string().parse(input.alias);
      await updateConfig(store, configRoot, current => {
        if (!Object.hasOwn(current.providers, alias)) throw new Error(`Unknown Provider: ${alias}`);
        const providers = { ...current.providers }; delete providers[alias];
        return configSchema.parse({ ...current, providers });
      });
      return { removed: alias };
    }
    case "model.list": {
      const provider = z.string().optional().parse(input.provider);
      const config = await store.load(configRoot);
      const catalogs = await restoreProviderCatalogs(Object.keys(config.providers), new FileModelsStore(), config.providers);
      return { defaultModel: config.defaultModel, models: listModelChoices(config, catalogs).filter(model => provider === undefined || model.provider === provider) };
    }
    case "model.set": {
      const config = await store.load(configRoot);
      const models = new FileModelsStore();
      const catalogs = await restoreProviderCatalogs(Object.keys(config.providers), models, config.providers);
      const saved = await saveModelSelection(configRoot, store, z.string().parse(input.alias), undefined, catalogs, undefined, models);
      return { defaultModel: saved.defaultModel };
    }
    default: throw new Error(`Unknown configuration command: ${action}`);
  }
}

/** Mask explicitly referenced MCP credentials before selecting a public setting path. */
function redactConfigurationOutput(config: AgentConfig): unknown {
  const safe = structuredClone(config);
  for (const server of Object.values(safe.extensions.mcp)) {
    for (const location of ["env", "headers"] as const) {
      const values = server[location];
      if (values === undefined) continue;
      for (const key of Object.keys(server.credentialRefs?.[location] ?? {})) {
        if (Object.hasOwn(values, key)) values[key] = "[redacted]";
      }
    }
  }
  return redactSensitiveValue(safe);
}
