/** Run only after approval; local synthetic content and no permissions requested by this fixture. */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
app.setName("Biny Cua Fixture");
app.setPath("userData", path.join(path.dirname(fileURLToPath(import.meta.url)), "../../artifacts/computer-use/fixture-profile"));
app.on("window-all-closed", () => app.quit());
// Electron waits for ESM evaluation before ready; top-level await whenReady deadlocks.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 760, height: 680, title: "Biny Cua Fixture · synthetic only", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  await window.loadFile(fileURLToPath(new URL("cua-native-fixture.html", import.meta.url)));
  console.log(JSON.stringify({ pid: process.pid, fixtureTitle: "Biny Cua Fixture · synthetic only" }));
});
