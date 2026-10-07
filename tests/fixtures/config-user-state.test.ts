import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureConfig, saveConfig, saveConfigFile } from "../../src/config/loader.js";
import { migrateLegacyGlobalState } from "../../src/config/globalStateMigration.js";
import { globalAgentDir, globalConfigDir } from "../../src/config/paths.js";
import { defaultConfig } from "../../src/config/schema.js";
import { withGlobalConfigWriteLock } from "../../src/config/versioned.js";
import { createCredentialStore, MacKeychainCredentialStore } from "../../src/config/credentials.js";
import { DesktopSafeStorageCredentialStore } from "../../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";

async function probe(mode: string): Promise<{ rejected: boolean; message?: string }> {
try {
  const root = path.join(os.homedir(), ".config", "biny");
  switch (mode) {
    case "explicit": await saveConfigFile(root, structuredClone(defaultConfig)); break;
    case "ensure": await ensureConfig(process.cwd(), { globalDir: root }); break;
    case "migration": await migrateLegacyGlobalState(); break;
    case "lock": await withGlobalConfigWriteLock(root, async () => undefined); break;
    case "safe-storage": await new DesktopSafeStorageCredentialStore(root).set("fixture", "fixture"); break;
    case "agent-path": globalAgentDir(); break;
    case "config-path": globalConfigDir(); break;
    case "keychain": await new MacKeychainCredentialStore().set("fixture", "fixture"); break;
    case "default-keychain": await createCredentialStore("darwin").set("fixture", "fixture"); break;
    case "child": {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", "import { saveConfig } from './src/config/loader.ts'; import { defaultConfig } from './src/config/schema.ts'; await saveConfig(process.cwd(), defaultConfig);"], { env, timeout: 5_000 });
      if (child.stdout) throw new Error("Child unexpectedly wrote output.");
      break;
    }
    default: await saveConfig(process.cwd(), structuredClone(defaultConfig));
  }
  return { rejected: false };
} catch (error) {
  return { rejected: true, message: error instanceof Error ? error.message : String(error) };
}
}

if (process.env.BINY_ISOLATION_PROBE === "all") {
  const results: Record<string, Awaited<ReturnType<typeof probe>>> = {};
  for (const mode of ["save", "explicit", "ensure", "migration", "lock", "safe-storage", "agent-path", "config-path", "keychain", "default-keychain", "child"]) results[mode] = await probe(mode);
  console.log(JSON.stringify(results));
} else console.log(JSON.stringify(await probe(process.env.BINY_ISOLATION_PROBE ?? "save")));
