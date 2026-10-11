import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

test("closing the preview owner skips its destroyed renderer and restores appearance in the surviving window", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-window-close-"));
  try {
    const entry = path.join(root, "main.mjs");
    const preload = path.join(root, "preload.cjs");
    await writeFile(preload, `
      const { ipcRenderer } = require("electron");
      ipcRenderer.on("appearance", (_event, snapshot) => ipcRenderer.send("appearance-received", snapshot));
    `);
    await build({
      stdin: {
        contents: `
          import assert from "node:assert/strict";
          import { app, BrowserWindow, ipcMain } from "electron";
          import { sendToDesktopWindow } from "./src/desktop/electron/main/window.js";
          import { AppearancePreviewCoordinator } from "./src/desktop/appearanceCoordinator.js";
          import { DEFAULT_APPEARANCE } from "./src/appearance/preferences.js";
          process.on("uncaughtException", error => { console.error(error); app.exit(1); });
          app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
          app.on("window-all-closed", () => {});
          app.whenReady().then(async () => {
            if (process.platform === "darwin") app.setActivationPolicy("prohibited");
            const owner = new BrowserWindow({ show: false });
            const survivor = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(preload)} } });
            const survivorContents = survivor.webContents;
            await owner.loadURL("about:blank");
            await survivor.loadURL("about:blank");
            const saved = { themePreference: "system", appearancePreference: DEFAULT_APPEARANCE, fontPreference: { family: "system", size: 14 } };
            const coordinator = new AppearancePreviewCoordinator({
              read: () => saved,
              publish: snapshot => {
                sendToDesktopWindow(owner, "appearance", snapshot);
                sendToDesktopWindow(survivor, "appearance", snapshot);
              }
            });
            coordinator.preview(owner.webContents.id, { ...saved, themePreference: "dark" });
            const received = new Promise(resolve => {
              ipcMain.on("appearance-received", (event, snapshot) => {
                if (event.sender === survivorContents && snapshot.themePreference === "system") resolve(snapshot);
              });
            });
            const ownerId = owner.webContents.id;
            await new Promise(resolve => {
              owner.webContents.once("destroyed", () => {
                assert.equal(owner.isDestroyed(), false, "renderer destruction precedes window destruction");
                assert.equal(owner.webContents.isDestroyed(), true);
                coordinator.release(ownerId);
                resolve();
              });
              owner.close();
            });
            assert.deepEqual(coordinator.snapshot(), saved);
            assert.deepEqual(await received, saved);
            assert.equal(owner.isDestroyed(), true);
            sendToDesktopWindow(owner, "appearance", saved);
            sendToDesktopWindow(undefined, "appearance", saved);
            survivor.destroy();
            console.log("window-close-restored");
            app.exit(0);
          }).catch(error => { console.error(error); app.exit(1); });
        `,
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
        sourcefile: "window-close-fixture.ts"
      },
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron"],
      logLevel: "silent"
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = process.platform === "linux" && process.env.CI ? ["--no-sandbox", entry] : [entry];
    const result = await promisify(execFile)(createRequire(import.meta.url)("electron") as string, args, { env, timeout: 15_000, killSignal: "SIGKILL" });
    assert.match(result.stdout, /window-close-restored/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
