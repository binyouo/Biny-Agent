import { renderElementTree, type ElementLike } from "./elementTree.js";
import type { DriverReply } from "./controller.js";
import type { BrowserAutomationEndpoint } from "../tools/browser.js";
import { randomUUID } from "node:crypto";
import { requestComputer } from "../tools/computerUse.js";
import { computerDesktopConnection, notifyDesktopComputerActivity } from "./desktopActivity.js";
import path from "node:path";
import { globalAgentDir, globalConfigDir } from "../config/paths.js";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import { ComputerAppApprovals } from "./appApprovals.js";
import { ComputerAuditStore } from "./auditStore.js";
import type { NativeProcessDriver } from "./nativeDriver.js";
import type { ComputerAction, WindowTarget } from "./protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ComputerMcpPolicy {
  close?(): Promise<void>;
  run(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult>;
}
const inputs = new Set(["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"]);
/** MCP 和 Desktop 共用启用选择、应用审批与日志；没有 Desktop 时仍执行同一策略。 */
export class LocalComputerMcpPolicy implements ComputerMcpPolicy {
  private readonly approvals: ComputerAppApprovals;
  private last?: WindowTarget;
  private observedAt = 0;
  private observedApp?: string;
  private desktop?: BrowserAutomationEndpoint;
  private desktopCapture?: { pid: number; windowId: string; captureId: string };
  private readonly transportId = `mcp:${randomUUID()}`;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly driver: NativeProcessDriver, private readonly store: AgentConfigStore = createFileConfigStore(globalAgentDir()),
    private readonly audit = new ComputerAuditStore(path.join(globalConfigDir(), "computer-actions.sqlite")),
    private readonly notify: (target: WindowTarget) => Promise<void> = notifyDesktopComputerActivity,
    private readonly getDesktop: () => Promise<BrowserAutomationEndpoint | undefined> = computerDesktopConnection) { this.approvals = new ComputerAppApprovals(store); }
  run(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult> {
    const result = this.tail.then(() => { signal?.throwIfAborted(); return this.execute(tool, args, operation, signal); }); this.tail = result.catch(() => undefined); return result;
  }
  async close(): Promise<void> {
    await this.tail;
    try { const desktop = this.desktop; if (desktop) await requestComputer(desktop, "release", { session: this.transportId }); }
    finally { this.audit.close(); }
  }
  private async execute(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult> {
    if (["permissions", "grant"].includes(tool)) return await operation();
    // 一旦接入桌面控制面，连接中断也不能退回独立输入绕过暂停。
    this.desktop ??= await this.getDesktop();
    if (this.desktop && !tool.startsWith("pip_")) return await this.runDesktop(tool, args, signal);
    if (tool.startsWith("pip_")) {
      const desktop = this.desktop;
      if (desktop) {
        const operation = tool.slice(4), reply = await requestComputer(desktop, "mirror", { operation, session: this.transportId, pid: args.pid, windowId: args.window_id === undefined ? undefined : String(args.window_id), onMinimize: args.on_minimize, all: args.all }, signal, operation !== "list");
        return { content: [{ type: "text", text: JSON.stringify(reply.data) }] };
      }
      if (tool !== "pip_open") return await operation();
    }
    const config = await this.store.load(); if (!config.computer.enabled) throw new Error("computer_disabled: 请先在设置中启用桌面控制");
    if (tool === "list_apps") return await operation();
    const listing = (await this.driver.list("mcp-policy", undefined)).data.apps;
    const apps = Array.isArray(listing) ? listing as { pid?: number; bundleId?: string; name?: string; running?: boolean }[] : [];
    const pid = typeof args.pid === "number" ? args.pid : typeof args.bundle === "string" ? apps.find(app => app.bundleId === args.bundle && app.running)?.pid : this.last?.pid;
    const matches = apps.filter(app => pid ? app.pid === pid && app.running : app.bundleId === args.bundle);
    let identity = matches.length === 1 ? matches[0] : undefined;
    if (!identity && args.pid === undefined && typeof args.bundle === "string") {
      const reply = await this.driver.daemonCommand("app_identity", { bundle: args.bundle });
      const candidate = reply.data;
      if (candidate.bundleId === args.bundle && typeof candidate.name === "string") identity = { bundleId: args.bundle, name: candidate.name, running: candidate.running === true };
    }
    if (!identity?.bundleId || !identity.name || (args.bundle !== undefined && args.bundle !== identity.bundleId)) throw new Error("computer_app_identity_unavailable");
    await this.approvals.authorize({ bundleId: identity.bundleId, appName: identity.name });
    if (inputs.has(tool) && (!this.last || Date.now() - this.observedAt >= 60_000 || this.observedApp !== identity.bundleId || this.last.pid !== pid || args.window_id !== undefined && String(args.window_id) !== this.last.windowId)) throw new Error("computer_observation_required: observe the exact target before input");
    if (inputs.has(tool) && this.last) { args.pid = this.last.pid; args.window_id = Number(this.last.windowId); }
    if (tool === "get_app_state") this.last = undefined;
    const at = Date.now(); let result: CallToolResult;
    try { result = await operation(); }
    catch (error) {
      if (inputs.has(tool) && config.computer.actionLogging && this.last) { try { this.audit.append({ at, action: tool as ComputerAction["action"], target: this.last, outcome: "unknown", durationMs: Date.now() - at, bundleId: identity.bundleId, errorCode: error instanceof Error ? error.message : String(error) }); } catch { throw new AggregateError([error], "computer_outcome_unknown: input may have been dispatched and its log could not be saved; do not repeat"); } }
      if (inputs.has(tool)) this.last = undefined;
      throw error;
    }
    const text = result.content.find(part => part.type === "text");
    if (tool === "get_app_state" && !result.isError && text?.type === "text") {
      // 观察的 JSON 是多行文本，后面可附树和说明书。
      const match = text.text.match(/"window_id"\s*:\s*(\d+)|"windowId"\s*:\s*(\d+)/);
      const observedPid = text.text.match(/"pid"\s*:\s*(\d+)/)?.[1];
      if (observedPid && match) { this.last = { pid: Number(observedPid), windowId: match[1] ?? match[2]! }; this.observedAt = Date.now(); this.observedApp = identity.bundleId; }
      else this.last = undefined;
    }
    if (inputs.has(tool) && this.last) {
      const outcome = ["unverifiable", "unverified"].includes(String(result.structuredContent?.effect)) ? "unverified" : result.isError ? /timeout|disconnect|aborted|unknown/i.test(text?.type === "text" ? text.text : "") ? "unknown" : "refused" : /verification_note|warning/.test(text?.type === "text" ? text.text : "") ? "unverified" : "completed";
      if (config.computer.actionLogging) { try { this.audit.append({ at, action: tool as ComputerAction["action"], target: this.last, outcome, durationMs: Date.now() - at, bundleId: identity.bundleId, errorCode: result.isError && text?.type === "text" ? text.text : undefined }); } catch { result.content.push({ type: "text", text: "The input was already dispatched, but the action log could not be saved. Do not repeat it." }); } }
      if (outcome !== "refused") { try { await this.notify(this.last); } catch { result.content.push({ type: "text", text: "Desktop preview notification failed. The input was already dispatched; do not repeat it." }); } }
    }
    if (inputs.has(tool)) this.last = undefined;
    return result;
  }
  private async runDesktop(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const call = (method: string, input: Record<string, unknown>, mutation = false) => requestComputer(this.desktop!, method, { ...input, session: this.transportId }, signal, mutation);
    let reply: DriverReply;
    if (tool === "list_apps") reply = await call("list", { days: args.days });
    else if (tool === "launch_app") reply = await call("launch", { bundleId: args.bundle }, true);
    else if (tool === "get_app_state") {
      this.desktopCapture = undefined;
      let pid = args.pid;
      if (pid === undefined) {
        const listed = await call("list", {});
        const apps = listed.data.apps as { pid?: number; bundleId?: string; running?: boolean }[];
        const matches = apps.filter(app => app.running && app.bundleId === args.bundle);
        if (matches.length > 1) throw new Error("computer_app_identity_unavailable: 请指定准确进程");
        pid = matches[0]?.pid;
        if (pid === undefined && typeof args.bundle === "string" && args.autoLaunch !== false) pid = (await call("launch", { bundleId: args.bundle }, true)).data.pid;
      }
      if (typeof pid !== "number") throw new Error("computer_observation_requires_target: 请指定应用或进程");
      let windowId = args.window_id === undefined ? undefined : String(args.window_id);
      if (!windowId) {
        const listed = await call("list", { pid });
        const apps = listed.data.apps as { pid?: number; windows?: { window_id: number }[] }[];
        const windows = apps.find(app => app.pid === pid)?.windows?.filter(window => window.window_id > 0) ?? [];
        if (windows.length !== 1) throw new Error("computer_window_selection_required: 请列出并指定准确窗口");
        windowId = String(windows[0]!.window_id);
      }
      reply = await call("observe", { pid, windowId, maxElements: args.maxElements, depth: args.depth, screenshotMaxWidth: args.screenshotMaxWidth, interactiveOnly: args.interactiveOnly });
    } else if (inputs.has(tool)) {
      const capture = this.desktopCapture;
      if (!capture || args.pid !== undefined && args.pid !== capture.pid || args.window_id !== undefined && String(args.window_id) !== capture.windowId) throw new Error("computer_observation_required: 请先观察同一窗口");
      if (args.bundle !== undefined) {
        const listed = await call("list", {});
        const apps = listed.data.apps as { pid?: number; bundleId?: string }[];
        if (!apps.some(app => app.pid === capture.pid && app.bundleId === args.bundle)) throw new Error("computer_app_identity_unavailable: 应用与当前观察不一致");
      }
      this.desktopCapture = undefined;
      reply = await call("action", { ...capture, action: tool, elementToken: args.ref, x: args.x, y: args.y,
        x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, text: args.text, key: args.key, value: args.value,
        location: args.location, length: args.length, direction: args.direction, pages: args.pages,
        button: args.button, clickCount: args.click_count, strategy: args.strategy, coordinateSpace: args.coord_space,
        inputMethod: args.inputMethod, showCursor: args.show_cursor }, true);
    } else throw new Error("computer_tool_unsupported");
    if (typeof reply.data.capture_id === "string") this.desktopCapture = { pid: Number(reply.data.pid), windowId: String(reply.data.window_id), captureId: reply.data.capture_id };
    const { elements, ...data } = reply.data;
    const tree = renderElementTree(elements as ElementLike[] | undefined);
    return { isError: !!reply.errorCode, content: [
      { type: "text", text: [JSON.stringify({ ...data, error: reply.errorCode }), tree].filter(Boolean).join("\n") },
      ...reply.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.dataBase64 }))
    ] };
  }

}
