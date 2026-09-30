/** Loaded only by the static ESM worker entry, never imported by the Electron main process. */
import * as CuaSdk from "@trycua/cua-driver";
import { z } from "zod";
import { cuaVersion, type ComputerAction, type WindowTarget } from "./protocol.js";
import { parseCuaReply } from "./cuaContract.js";
import { scopeWindowObservation } from "./windowScope.js";
import type { ComputerDriver, DriverReply } from "./controller.js";
import { planMacOsScroll, readMacOsNaturalScrolling, scrollObservationFromReply, type ScrollObservation } from "./macOsScroll.js";

function safeWindowId(target: WindowTarget): number {
  const id = BigInt(target.windowId);
  if (id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("window_id_not_json_safe: this release refuses lossy generic JSON encoding");
  return Number(id);
}
export class CuaNativeRuntime implements ComputerDriver {
  private driver?: CuaSdk.CuaDriverLike;
  private scrollObservation?: ScrollObservation;
  async diagnostics(): Promise<DriverReply> {
    const status = process.platform === "darwin" ? CuaSdk.currentMacOsPermissionStatus() : undefined;
    return { data: { sdkLoaded: true, runtimeReady: Boolean(this.driver), driverVersion: this.driver ? (await this.driver.metadata()).driverVersion : undefined, permissions: { accessibility: status ? status.accessibility ? "granted" : "denied" : "unknown", screenRecording: status ? status.screenRecording ? "granted" : "denied" : "unknown" } }, images: [] };
  }
  async start(): Promise<void> {
    if (this.driver) return;
    if (process.platform === "darwin") {
      const status = CuaSdk.currentMacOsPermissionStatus();
      if (!status.accessibility || !status.screenRecording) throw new Error(`permission_required: current Biny host accessibility=${status.accessibility}, screenRecording=${status.screenRecording}; no grants requested`);
    }
    const driver = CuaSdk.CuaDriver.create(undefined); this.driver = driver;
    try { if ((await driver.metadata()).driverVersion !== cuaVersion) throw new Error("driver_version_mismatch: expected 0.30.4"); }
    catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    const driver = this.driver; this.driver = undefined; this.scrollObservation = undefined;
    try { await driver?.shutdown(); } finally { if (driver && "uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function") driver.uniffiDestroy(); }
  }
  private ready(): { sdk: typeof CuaSdk; driver: CuaSdk.CuaDriverLike } {
    if (!this.driver) throw new Error("driver_not_connected");
    if (process.platform === "darwin") {
      const status = CuaSdk.currentMacOsPermissionStatus();
      if (!status.accessibility || !status.screenRecording) throw new Error("permission_required: grants changed; fully relaunch Biny after restoring them");
    }
    return { sdk: CuaSdk, driver: this.driver };
  }
  async list(session: string, pid: number | undefined, signal: AbortSignal): Promise<DriverReply> {
    const { driver } = this.ready();
    const reply = pid === undefined ? await driver.listApps(CuaSdk.ListAppsInput.new({ session }), { signal }) : await driver.listWindows(CuaSdk.ListWindowsInput.new({ pid }), { signal });
    const data: unknown = JSON.parse(JSON.stringify(reply, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
    return { data: z.record(z.unknown()).parse(data), images: [] };
  }
  async observe(session: string, target: WindowTarget, signal: AbortSignal): Promise<DriverReply> {
    const { driver } = this.ready();
    this.scrollObservation = undefined;
    const reply = parseCuaReply(await driver.callTool("get_window_state", JSON.stringify({ pid: target.pid, window_id: safeWindowId(target), session, include_screenshot: true, max_image_dimension: 1280, max_elements: 200, max_depth: 15 }), { signal }));
    signal.throwIfAborted();
    if (reply.errorCode) return reply;
    const data = scopeWindowObservation(reply.data);
    if (this.driver === driver) this.scrollObservation = scrollObservationFromReply(session, data, Date.now());
    return { ...reply, data };
  }
  async act(session: string, action: ComputerAction, signal: AbortSignal): Promise<DriverReply> {
    signal.throwIfAborted();
    const { sdk, driver } = this.ready();
    const observation = this.scrollObservation; this.scrollObservation = undefined;
    if (action.action === "scroll" && process.platform === "darwin") {
      const natural = await readMacOsNaturalScrolling(signal);
      const plan = planMacOsScroll(session, action, observation, natural, Date.now());
      if (plan.refusal) return plan.refusal;
      if (signal.aborted) return { data: { effect: "refused", dispatched: false }, images: [], errorCode: "scroll_cancelled_before_dispatch" };
      const reply = parseCuaReply(await driver.callTool("scroll", JSON.stringify(plan.args), { signal }));
      return { ...reply, data: { ...reply.data, scrollContract: { direction: action.direction, sdkDirection: plan.args?.direction, by: "line", amount: action.amount ?? 1, naturalScrolling: natural, mapped: plan.mapped } } };
    }
    if (action.action === "click") {
      try {
        const result = await driver.click(sdk.ClickInput.new({ target: new sdk.ActionTarget.Window({ pid: action.pid, windowId: BigInt(action.windowId) }), position: new sdk.ClickPosition.CapturedCoordinates({ x: action.x!, y: action.y!, captureId: action.captureId }), deliveryMode: action.delivery === "foreground" ? sdk.InputDeliveryMode.Foreground : sdk.InputDeliveryMode.Background, session }), { signal });
        const effects = ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"];
        return { data: { effect: effects[result.effect] ?? "unverifiable", code: result.error?.code }, images: [], errorCode: result.error?.code };
      } catch (error) {
        if (sdk.DriverError.Tool.instanceOf(error)) {
          // The SDK exposes a structured refusal serialized in reason; preserve it, never retry foreground.
          let data: Record<string, unknown>;
          try { data = z.record(z.unknown()).parse(JSON.parse(error.inner.message)); }
          catch { data = { reason: error.inner.message }; }
          return { data: { ...data, effect: "refused" }, images: [], errorCode: error.inner.errorCode };
        }
        throw error;
      }
    }
    const args = { session, pid: action.pid, window_id: safeWindowId(action), delivery_mode: action.delivery, element_token: action.elementToken, text: action.text, key: action.key, direction: action.direction, amount: action.amount };
    return parseCuaReply(await driver.callTool(action.action, JSON.stringify(args), { signal }));
  }
}
