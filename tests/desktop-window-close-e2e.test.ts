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

test("appearance preview and owner close preserve transparent window backgrounds while restoring the surviving renderer", { timeout: 20_000 }, async () => {
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
          import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
          import { sendToDesktopWindow, syncDesktopWindowAppearance } from "./src/desktop/electron/main/window.js";
          import { AppearancePreviewCoordinator } from "./src/desktop/appearanceCoordinator.js";
          import { DEFAULT_APPEARANCE } from "./src/appearance/preferences.js";
          process.on("uncaughtException", error => { console.error(error); app.exit(1); });
          app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
          app.on("window-all-closed", () => {});
          const stage = name => console.log("window-close-stage: " + name);
          stage("waiting-for-app-ready");
          app.whenReady().then(async () => {
            stage("creating-windows");
            if (process.platform === "darwin") app.setActivationPolicy("prohibited");
            const owner = new BrowserWindow({ show: false, transparent: process.platform === "darwin", backgroundColor: "#00000000" });
            const survivor = new BrowserWindow({ show: false, title: "Biny Quick Chat", transparent: process.platform === "darwin", backgroundColor: "#00000000", webPreferences: { preload: ${JSON.stringify(preload)} } });
            // Electron 的读取接口不返回 alpha；记录边界实参，同时继续执行真实原生调用。
            const appliedBackgrounds = new Map();
            for (const window of [owner, survivor]) {
              const setBackgroundColor = window.setBackgroundColor.bind(window);
              window.setBackgroundColor = color => { appliedBackgrounds.set(window, color); setBackgroundColor(color); };
            }
            const survivorContents = survivor.webContents;
            stage("loading-owner");
            await owner.loadURL("about:blank");
            stage("loading-survivor");
            await survivor.loadURL("about:blank");
            stage("checking-appearance-preview");
            const saved = { themePreference: "system", appearancePreference: DEFAULT_APPEARANCE, fontPreference: { family: "system", size: 14 } };
            const coordinator = new AppearancePreviewCoordinator({
              read: () => saved,
              publish: snapshot => {
                syncDesktopWindowAppearance(owner, snapshot);
                sendToDesktopWindow(owner, "appearance", snapshot);
                sendToDesktopWindow(survivor, "appearance", snapshot);
              }
            });
            const checkBackgrounds = () => {
              const preference = coordinator.snapshot().themePreference;
              const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
              const expected = process.platform === "darwin" ? "#00000000" : dark ? "#1a1a1a" : "#f5f5f5";
              for (const window of [owner, survivor]) {
                if (!window.isDestroyed()) {
                  assert.equal(appliedBackgrounds.get(window), expected, "appearance synchronization preserves platform background");
                  assert.equal(window.getBackgroundColor().toLowerCase(), process.platform === "darwin" ? "#000000" : expected);
                }
              }
            };
            appliedBackgrounds.clear();
            coordinator.refresh();
            checkBackgrounds();
            appliedBackgrounds.clear();
            coordinator.preview(owner.webContents.id, { ...saved, themePreference: "dark" });
            checkBackgrounds();
            appliedBackgrounds.clear();
            coordinator.committed();
            checkBackgrounds();
            appliedBackgrounds.clear();
            coordinator.preview(owner.webContents.id, { ...saved, themePreference: "light" });
            checkBackgrounds();
            saved.fontPreference.size = 16;
            const received = new Promise(resolve => {
              ipcMain.on("appearance-received", (event, snapshot) => {
                if (event.sender === survivorContents && snapshot.themePreference === "system" && snapshot.fontPreference.size === 16) resolve(snapshot);
              });
            });
            const ownerId = owner.webContents.id;
            stage("closing-owner");
            await new Promise(resolve => {
              owner.webContents.once("destroyed", () => {
                assert.equal(owner.isDestroyed(), false, "renderer destruction precedes window destruction");
                assert.equal(owner.webContents.isDestroyed(), true);
                appliedBackgrounds.clear();
                coordinator.release(ownerId);
                resolve();
              });
              owner.close();
            });
            assert.deepEqual(coordinator.snapshot(), saved);
            stage("awaiting-restored-appearance");
            assert.deepEqual(await received, saved);
            stage("checking-closed-window");
            assert.equal(owner.isDestroyed(), true);
            checkBackgrounds();
            sendToDesktopWindow(owner, "appearance", saved);
            sendToDesktopWindow(undefined, "appearance", saved);
            survivor.destroy();
            stage("exiting");
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
    const result = await promisify(execFile)(createRequire(import.meta.url)("electron") as string, args, { env, timeout: 15_000, killSignal: "SIGKILL" }).catch((error: unknown) => {
      const failure = error as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: string; stderr?: string };
      // execFile captures child output, so successful runs stay quiet. On failure,
      // retain the last reached stage and native errors instead of only "Command failed".
      throw new Error([
        `Electron window-close fixture failed: ${JSON.stringify({ code: failure.code, signal: failure.signal, killed: failure.killed })}`,
        `stdout:\n${failure.stdout ?? ""}`,
        `stderr:\n${failure.stderr ?? ""}`
      ].join("\n"), { cause: error });
    });
    assert.match(result.stdout, /window-close-restored/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
