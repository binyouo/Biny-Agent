import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { DesktopSafeStorageCredentialStore, type SafeStorageCipher } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-detached-credentials-"));
try {
  assert.equal(new DesktopConfigStore(root).supportsDetachedRuntimeHost, true, "the Electron-backed credential store can be shared with an independent Electron Host");
  assert.equal(new DesktopConfigStore(root, new EnvironmentCredentialStore()).supportsDetachedRuntimeHost, false, "injected stores must not claim detached credential access");

  const cipher: SafeStorageCipher = {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
    decrypt: (payload) => payload.toString("utf8").split("").reverse().join("")
  };
  const desktop = new DesktopSafeStorageCredentialStore(root, () => cipher);
  const host = new DesktopSafeStorageCredentialStore(root, () => cipher);

  await desktop.set("provider:primary:apiKey", "initial-secret");
  assert.equal(await host.get("provider:primary:apiKey"), "initial-secret");

  await desktop.set("provider:primary:apiKey", "rotated-secret");
  assert.equal(await host.get("provider:primary:apiKey"), "rotated-secret", "a live Host must observe credentials rotated by Desktop");

  await desktop.delete("provider:primary:apiKey");
  assert.equal(await host.get("provider:primary:apiKey"), undefined, "a live Host must observe credentials revoked by Desktop");

  const persisted = await readFile(path.join(root, "credentials.enc"), "utf8");
  assert.ok(!persisted.includes("initial-secret") && !persisted.includes("rotated-secret"));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log("desktop credential store tests passed");
