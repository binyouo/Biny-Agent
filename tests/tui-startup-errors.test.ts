import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { saveConfigFile } from "../src/config/loader.js";
import { globalConfigDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { BinyTui } from "../src/tui/app.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-tui-startup-error-")));
const terminal: Terminal = {
  start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
  write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
  moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
  clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
  setTitle: () => undefined, setProgress: () => undefined
};
const app = new BinyTui(new TUI(terminal), root);
try {
  const providerAlias = `unconfigured-fixture-${randomUUID()}`;
  const missingEnv = `BINY_MISSING_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  await saveConfigFile(globalConfigDir(), {
    ...structuredClone(defaultConfig), defaultModel: "unconfigured-test",
    providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: true, apiKeyEnv: missingEnv } },
    models: { "unconfigured-test": { provider: providerAlias, model: "unconfigured-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  // Given a missing credential, When detached and local startup fail, Then show
  // the model configuration cause instead of replacing it with process exit.
  await app.submit("preserved startup message");
  const notifications = app.tuiState.transcript.committed.filter(item => item.kind === "notification");
  assert.ok(notifications.some(item => item.content.includes("尚未就绪") && item.content.includes("No model available")), JSON.stringify(notifications));
  assert.equal(app.tuiState.sessionId, "");
} finally {
  await app.exit();
  await rm(root, { recursive: true, force: true });
}
console.log("tui startup error tests passed");
