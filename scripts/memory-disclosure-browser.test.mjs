/* global document, window, getComputedStyle, requestAnimationFrame */
/** Real Electron/Chromium rendering and trusted input. Run under xvfb-run on Linux CI. */
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const output = path.resolve(".memory-disclosure-results");
const results = { electron: process.versions.electron, chromium: process.versions.chrome,
  variants: [] };
let win;
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function painted() {
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function waitFor(fn, ...args) {
  const deadline = Date.now() + 5_000;
  do {
    if (await evaluate(fn, ...args)) return;
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error(`Renderer condition timed out: ${fn.toString()}`);
}
async function focus(index) {
  win.focus();
  await evaluate(index => window.__disclosureQa.elements()[index].focus(), index);
  assert.equal(await evaluate(index => document.activeElement === window.__disclosureQa.elements()[index], index), true);
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode === "Enter" || keyCode === "Space") {
    win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
  }
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await painted();
}
async function click(index, child) {
  const point = await evaluate((index, child) => {
    const parent = window.__disclosureQa.elements()[index];
    const element = child ? parent.querySelector(child) : parent;
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  }, index, child);
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await painted();
}
async function check(index, open) {
  await waitFor((index, open) => window.__disclosureQa.open(index) === open, index, open);
  const value = await evaluate(index => {
    const element = window.__disclosureQa.elements()[index];
    const icon = element.querySelector(".activity-memory-disclosure-chevron");
    const panel = index < 2 ? document.getElementById(element.getAttribute("aria-controls")) : element.nextElementSibling;
    return {
      expanded: element.getAttribute("aria-expanded"),
      hidden: index < 2 ? document.getElementById(element.getAttribute("aria-controls")).hidden : null,
      visible: panel.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        && panel.getBoundingClientRect().height > 0,
      transform: getComputedStyle(icon).transform,
      path: icon.querySelector("path")?.getAttribute("d")
    };
  }, index);
  if (index < 2) { assert.equal(value.expanded, String(open)); assert.equal(value.hidden, !open); }
  assert.equal(value.visible, open, "the panel must actually render only while expanded");
  assert.equal(value.transform, open ? "matrix(-1, 0, 0, -1, 0, 0)" : "none", `direction of disclosure ${index}`);
  assert.equal(value.path, "m6 9 6 6 6-6", "the unrotated SVG points down");
}
async function capture(name) {
  await evaluate(() => {
    const first = window.__disclosureQa.elements()[0];
    window.scrollTo(0, first.getBoundingClientRect().top + window.scrollY - 12);
    document.activeElement?.blur();
  });
  await painted();
  const clip = await evaluate(() => {
    const first = window.__disclosureQa.elements()[0].getBoundingClientRect();
    const card = document.getElementById("memory-sleep").getBoundingClientRect();
    return { x: Math.floor(card.x), y: Math.max(0, Math.floor(first.y - 8)),
      width: Math.ceil(card.width), height: Math.ceil(card.bottom - first.y + 8) };
  });
  const [width, height] = win.getContentSize();
  assert.ok(clip.x >= 0 && clip.x + clip.width <= width && clip.y + clip.height <= height, "capture must fit the viewport");
  const image = await win.webContents.capturePage(clip);
  assert.equal(image.isEmpty(), false);
  await writeFile(path.join(output, `${name}.png`), image.toPNG());
}
async function metrics() {
  return evaluate(() => window.__disclosureQa.elements().map(element => {
    const label = element.querySelector("span")?.getBoundingClientRect();
    return {
      text: element.textContent, fontSize: parseFloat(getComputedStyle(element).fontSize),
      listStyle: getComputedStyle(element).listStyleType,
      marker: getComputedStyle(element, "::marker").content,
      icons: [...element.querySelectorAll("svg")].map(icon => {
        const rect = icon.getBoundingClientRect();
        return { width: rect.width, height: rect.height,
          centerDelta: label ? Math.abs(rect.y + rect.height / 2 - label.y - label.height / 2) : null };
      })
    };
  }));
}

app.disableHardwareAcceleration();
// Closing the baseline window must not terminate Electron before the after assertions.
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => {
  console.error(`Renderer acceptance timed out (Electron ready: ${app.isReady()})`);
  app.exit(1);
}, 120_000);
// ESM entrypoint evaluation must finish before Electron can emit ready.
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });

async function run() {
console.log("Electron ready; starting renderer acceptance");
await mkdir(output, { recursive: true });
results.source = JSON.parse(await readFile(".memory-disclosure-build/source.json", "utf8"));
try {
  for (const phase of ["before", "after"]) {
    const file = path.resolve(".memory-disclosure-build", phase, "index.html");
    if (phase === "before" && !(await access(file).then(() => true, () => false))) continue;
    console.log(`Rendering ${phase} fixture`);
    win = new BrowserWindow({ width: 900, height: 2200, useContentSize: true, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadFile(file);
    win.focus();
    await waitFor(() => !!document.querySelector(".activity-memory-run-details > summary"));
    assert.equal(await evaluate(() => {
      const host = document.querySelector("dialog.memory-fixture.desktop-settings-dialog[open]");
      if (!host) return false;
      const rect = host.getBoundingClientRect();
      return host.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        && rect.width > 0 && rect.height > 0;
    }), true, `${phase} fixture must render an open, visible settings dialog before input`);
    await evaluate(() => {
      const elements = () => {
        const buttons = [...document.querySelectorAll("button.activity-memory-disclosure")];
        return [buttons.find(el => el.textContent.includes("相似度与 LLM")),
          buttons.find(el => el.textContent.includes("归档记忆")), document.querySelector(".activity-memory-run-details > summary")];
      };
      window.__disclosureQa = { elements, events: [], errors: [], open: index => index === 2
        ? elements()[2].parentElement.open : elements()[index].getAttribute("aria-expanded") === "true" };
      for (const type of ["keydown", "keyup", "click"]) document.addEventListener(type, event => {
        window.__disclosureQa.events.push({ type, key: event.key, trusted: event.isTrusted });
      }, true);
      window.addEventListener("error", event => window.__disclosureQa.errors.push(event.message));
      window.addEventListener("unhandledrejection", event => window.__disclosureQa.errors.push(String(event.reason)));
    });
    await capture(`${phase}-dark-100-collapsed`);
    if (phase === "before") {
      results.before = await metrics();
      for (let i = 0; i < 3; i++) await click(i);
      await capture("before-dark-100-expanded");
    } else {
      for (let i = 0; i < 3; i++) {
        console.log(`Testing disclosure ${i + 1}: native Enter/Space and pointer input`);
        await check(i, false);
        await focus(i); await key("Enter"); await check(i, true);
        await key("Space"); await check(i, false);
        await click(i, ".activity-memory-disclosure-chevron"); await check(i, true);
        await click(i, "span"); await check(i, false);
        await click(i); await check(i, true);
        await click(i); await click(i); await check(i, true);
      }
      await evaluate(() => document.querySelector('input[aria-label="相似度合并阈值"]').focus());
      await key("End");
      for (let i = 0; i < 5; i++) await key("Left");
      assert.equal(await evaluate(() => document.querySelector('input[aria-label="相似度合并阈值"]').value), "95");
      await check(0, true);
      await evaluate(() => { window.__disclosureQa.slider = document.querySelector('input[aria-label="相似度合并阈值"]'); });
      await click(0); await check(0, false); await click(0); await check(0, true);
      assert.equal(await evaluate(() => document.querySelector('input[aria-label="相似度合并阈值"]').value), "95", "child value survives collapse");
      assert.equal(await evaluate(() => window.__disclosureQa.slider.isConnected
        && window.__disclosureQa.slider === document.querySelector('input[aria-label="相似度合并阈值"]')), true, "child DOM survives collapse");
      const loads = await evaluate(() => Number(document.getElementById("root").dataset.loads));
      await evaluate(() => document.querySelector('button[aria-label="刷新记忆"]').focus());
      await key("Enter");
      await waitFor(loads => Number(document.getElementById("root").dataset.loads) > loads
        && !document.querySelector('button[aria-label="刷新记忆"]').disabled, loads);
      for (let i = 0; i < 3; i++) await check(i, true);
      for (const theme of ["dark", "light"]) {
        for (const scale of [1, 1.5]) {
          win.setContentSize(scale === 1 ? 900 : 440, 2200);
          await evaluate((theme, scale) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty("--app-font-size", String(14 * scale));
          }, theme, scale);
          await painted();
          const geometry = await metrics();
          assert.equal(geometry.length, 3);
          for (const [index, item] of geometry.entries()) {
            assert.equal(item.icons.length, index === 0 ? 1 : 2);
            for (const icon of item.icons) {
              assert.ok(Math.abs(icon.width - item.fontSize) < 0.1, "icon width follows font size");
              assert.ok(Math.abs(icon.height - item.fontSize) < 0.1, "icon height follows font size");
              assert.ok(icon.centerDelta < 0.6, "icon is centered on its label");
            }
          }
          assert.equal(geometry[2].listStyle, "none");
          assert.equal(geometry[2].marker, '""');
          results.variants.push({ theme, scale, geometry });
          console.log(`Verified ${theme} ${scale * 100}% geometry`);
          await capture(`after-${theme}-${scale * 100}-expanded`);
        }
      }
      const audit = await evaluate(() => ({ events: window.__disclosureQa.events, errors: window.__disclosureQa.errors }));
      assert.deepEqual(audit.errors, []);
      assert.ok(audit.events.length > 20 && audit.events.every(event => event.trusted), "all exercised keyboard/mouse input is trusted");
      assert.ok(audit.events.some(event => event.key === "Enter") && audit.events.some(event => event.key === " "));
      results.input = audit;
    }
    win.destroy(); win = undefined;
  }
  assert.equal(results.variants.length, 4, "the after renderer must complete every variant");
  assert.ok(results.input?.events.length > 20, "native input acceptance must finish");
  results.passed = true;
  console.log("PASS: real renderer geometry, native disclosure keyboard input, child state and refresh retention");
} catch (error) {
  results.passed = false;
  results.error = String(error.stack ?? error);
  console.error(error);
  if (win && !win.isDestroyed()) await writeFile(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
} finally {
  clearTimeout(watchdog);
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  app.exit(results.passed ? 0 : 1);
}
}
