import assert from "node:assert/strict";
import { ActivityCaptureEngine } from "../src/activity/captureEngine.js";
import { activitySettingsSchema, defaultActivitySettings } from "../src/activity/settings.js";

let manual = 0;
let screen = 0;
const settings = { ...defaultActivitySettings, captureDebounceMs: 0 };
const engine = new ActivityCaptureEngine({
  appshot: async () => { manual++; return Buffer.from("window"); },
  native: async () => { screen++; return Buffer.from("screen"); },
  desktop: async () => { screen++; return Buffer.from("desktop"); },
  frame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) })
});
const first = await engine.capture(settings, "appshot");
assert.equal(first?.jpeg.toString(), "window");
assert.ok(await engine.capture(settings, "appshot"), "manual captures are retained even if the window is unchanged");
assert.equal(manual, 2); assert.equal(screen, 0);
const refused = new ActivityCaptureEngine({
  appshot: async () => { throw new Error("appshot_application_excluded"); },
  native: async () => { screen++; return Buffer.from("screen"); }, desktop: async () => { screen++; return Buffer.from("desktop"); },
  frame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) })
});
await assert.rejects(refused.capture(settings, "appshot"), /appshot_application_excluded/);
assert.equal(screen, 0, "a failed window capture must not fall back to a full display");
assert.equal("appshotHotkey" in activitySettingsSchema.parse({ appshotHotkey: "Control+Alt+C" }), false);
assert.equal("appshotHotkey" in activitySettingsSchema.parse({}), false);

let now = 0;
let failing = true;
const retry = new ActivityCaptureEngine({
  now: () => now,
  appshot: async () => { if (failing) throw new Error("capture_failed"); return Buffer.from("window"); },
  native: async () => { throw new Error("unexpected display capture"); },
  desktop: async () => { throw new Error("unexpected display capture"); },
  frame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) })
});
await assert.rejects(retry.capture(settings, "appshot"), /capture_failed/);
now = 500; failing = false;
assert.ok(await retry.capture(settings, "appshot"));
failing = true;
await assert.rejects(retry.capture(settings, "appshot"), /capture_failed/);
now = 1000; failing = false;
assert.ok(await retry.capture(settings, "appshot"), "a successful manual capture resets consecutive-failure backoff");
