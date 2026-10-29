import { legacyActionPayload, legacyAutoLaunch, legacyObservationOptions } from "./input.js";
import { externalElements, renderElementTree, type ElementLike } from "./elementTree.js";
import type { DriverReply } from "./controller.js";
import type { BrowserAutomationEndpoint } from "../tools/browser.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
async function waitForWindow(pid: number, bundle: string, list: (signal: AbortSignal) => Promise<DriverReply>, signal?: AbortSignal, initial?: DriverReply): Promise<number> {
  const deadline = AbortSignal.timeout(5_000);
  const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (;;) {
      waiting.throwIfAborted();
      const reply = initial ?? await list(waiting);
      initial = undefined;
      waiting.throwIfAborted();
      const apps = Array.isArray(reply.data.apps) ? reply.data.apps as { pid?: number; bundleId?: string; running?: boolean; windows?: { window_id: number; focused?: boolean }[] }[] : [];
      const matches = apps.filter(app => app.pid === pid && app.running);
      if (matches.length > 1 || (matches[0] && matches[0].bundleId !== bundle)) throw new Error("computer_app_identity_unavailable: 应用身份不匹配");
      const windows = matches[0]?.windows?.filter(window => Number.isSafeInteger(window.window_id) && window.window_id > 0) ?? [];
      const focused = windows.filter(window => window.focused === true);
      if (focused.length === 1) return focused[0]!.window_id;
      if (windows.length > 1) throw new Error("computer_window_selection_required: 请列出并指定准确窗口");
      if (windows.length === 1) return windows[0]!.window_id;
      await delay(200, undefined, { signal: waiting });
    }
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new Error("computer_window_not_ready: 目标窗口尚未出现；先查询应用状态，不要重复启动。");
    throw error;
  }
}
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
  private readonly lifetime = new AbortController();
  private closePromise?: Promise<void>;
  constructor(private readonly driver: NativeProcessDriver, private readonly store: AgentConfigStore = createFileConfigStore(globalAgentDir()),
    private readonly audit = new ComputerAuditStore(path.join(globalConfigDir(), "computer-actions.sqlite")),
    private readonly notify: (target: WindowTarget) => Promise<void> = notifyDesktopComputerActivity,
    private readonly getDesktop: () => Promise<BrowserAutomationEndpoint | undefined> = computerDesktopConnection) { this.approvals = new ComputerAppApprovals(store); }
  run(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult> {
    const active = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const result = this.tail.then(() => { active.throwIfAborted(); return this.execute(tool, args, operation, active); }); this.tail = result.catch(() => undefined); return result;
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return this.closePromise ??= (async () => {
      await this.tail;
      try { const desktop = this.desktop; if (desktop) await requestComputer(desktop, "release", { session: this.transportId }, AbortSignal.timeout(2_000)); }
      finally { this.audit.close(); }
    })();
  }
  private async execute(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult> {
    if (["permissions", "grant"].includes(tool)) return await operation();
    // 一旦接入桌面控制面，连接中断也不能退回独立输入绕过暂停。
    this.desktop ??= await this.getDesktop();
    if (this.desktop && !tool.startsWith("pip_")) return await this.runDesktop(tool, args, signal);
    if (args.waitFor !== undefined || tool === "sequence") throw new Error("computer_desktop_required: 文字等待和连续动作需要正在运行的 Desktop 控制器");
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
    const bundleMatches = typeof args.bundle === "string" ? apps.filter(app => app.bundleId === args.bundle && app.running) : [];
    if (args.pid === undefined && bundleMatches.length > 1) throw new Error("computer_app_identity_unavailable: 请指定准确进程");
    const pid = typeof args.pid === "number" ? args.pid : typeof args.bundle === "string" ? bundleMatches[0]?.pid : this.last?.pid;
    const matches = apps.filter(app => pid ? app.pid === pid && app.running : app.bundleId === args.bundle);
    if (pid && matches.length > 1) throw new Error("computer_app_identity_unavailable: 进程身份不唯一");
    let identity = matches.length === 1 ? matches[0] : undefined;
    if (!identity && args.pid === undefined && typeof args.bundle === "string") {
      const reply = await this.driver.daemonCommand("app_identity", { bundle: args.bundle });
      const candidate = reply.data;
      if (candidate.bundleId === args.bundle && typeof candidate.name === "string") identity = { bundleId: args.bundle, name: candidate.name, running: candidate.running === true };
    }
    if (!identity?.bundleId || !identity.name || (args.bundle !== undefined && args.bundle !== identity.bundleId)) throw new Error("computer_app_identity_unavailable");
    await this.approvals.authorize({ bundleId: identity.bundleId, appName: identity.name });
    if (tool === "get_app_state") this.last = undefined;
    const shouldLaunch = tool === "get_app_state" && args.pid === undefined && identity.running === false && legacyAutoLaunch(args) !== false;
    const shouldSelectWindow = tool === "get_app_state" && args.window_id === undefined && (shouldLaunch || identity.running === true);
    if (shouldLaunch || shouldSelectWindow) {
      const beforeLaunch = await this.approvals.read();
      const approved = beforeLaunch.apps.find(app => app.bundleId === identity.bundleId);
      if (!beforeLaunch.enabled || !approved?.approvedAt || approved.revokedAt) throw new Error("computer_authorization_invalidated: 应用授权已改变");
      signal?.throwIfAborted();
      let targetPid = pid;
      if (shouldLaunch) {
        let launched: DriverReply;
        try { launched = await this.driver.launchApp(identity.bundleId, signal); }
        catch { throw new Error("computer_launch_outcome_unknown: 应用启动结果未知；先查询应用状态，不要重复启动。"); }
        const launchedPid = launched.data.pid;
        if (launched.errorCode || typeof launchedPid !== "number" || !Number.isSafeInteger(launchedPid) || launchedPid <= 0) throw new Error("computer_launch_outcome_unknown: 未确认启动进程；先查询应用状态，不要重复启动。");
        targetPid = launchedPid;
      }
      if (typeof targetPid !== "number" || !Number.isSafeInteger(targetPid) || targetPid <= 0) throw new Error("computer_app_identity_unavailable: 请指定准确进程");
      args.pid = targetPid;
      if (shouldSelectWindow) args.window_id = await waitForWindow(targetPid, identity.bundleId, async waiting => await this.driver.list("mcp-policy", targetPid, waiting), signal);
      const afterLaunch = await this.approvals.read();
      const current = afterLaunch.apps.find(app => app.bundleId === identity.bundleId);
      if (!afterLaunch.enabled || afterLaunch.strictApproval !== beforeLaunch.strictApproval || current?.approvedAt !== approved.approvedAt || current?.revokedAt !== approved.revokedAt) throw new Error("computer_authorization_invalidated: 等待窗口期间应用授权已改变；应用可能已启动。");
      signal?.throwIfAborted();
    }
    if (tool === "get_app_state" && args.pid === undefined && identity.running === true && pid !== undefined) args.pid = pid;
    if (inputs.has(tool) && (!this.last || Date.now() - this.observedAt >= 60_000 || this.observedApp !== identity.bundleId || this.last.pid !== pid || args.window_id !== undefined && String(args.window_id) !== this.last.windowId)) throw new Error("computer_observation_required: observe the exact target before input");
    if (inputs.has(tool) && this.last) { args.pid = this.last.pid; args.window_id = Number(this.last.windowId); }
    const at = Date.now(); let result: CallToolResult;
    try { result = await operation(); }
    catch (error) {
      if (inputs.has(tool) && config.computer.actionLogging && this.last) { try { this.audit.append({ at, action: tool as ComputerAction["action"], target: this.last, outcome: "unknown", durationMs: Date.now() - at, bundleId: identity.bundleId, errorCode: error instanceof Error ? error.message : String(error) }); } catch { throw new AggregateError([error], "computer_outcome_unknown: input may have been dispatched and its log could not be saved; do not repeat"); } }
      if (inputs.has(tool)) this.last = undefined;
      throw error;
    }
    const text = result.content.find(part => part.type === "text");
    if (tool === "get_app_state" && !result.isError && result.content.some(part => part.type === "image")) {
      // 只有结果包含图片的观察才可用于后续输入。
      const data = result.structuredContent;
      if (!data || data.pid !== args.pid || Number(data.window_id ?? data.windowId) !== Number(args.window_id)) throw new Error("capture_target_mismatch: 观察结果与请求目标不一致");
      this.last = { pid: Number(data.pid), windowId: String(data.window_id ?? data.windowId) };
      this.observedAt = Date.now(); this.observedApp = identity.bundleId;
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
    const call = (method: string, input: Record<string, unknown>, mutation = false, requestSignal = signal) => requestComputer(this.desktop!, method, { ...input, session: this.transportId }, requestSignal, mutation);
    let reply: DriverReply;
    if (tool === "list_apps") reply = await call("list", { days: args.days });
    else if (tool === "launch_app") reply = await call("launch", { bundleId: args.bundle }, true);
    else if (tool === "sequence") {
      const capture = this.desktopCapture;
      if (!capture || args.pid !== capture.pid || args.windowId !== capture.windowId || args.captureId !== capture.captureId) throw new Error("computer_observation_required: 请先观察同一窗口");
      this.desktopCapture = undefined;
      reply = await call("sequence", args, true);
    }
    else if (tool === "get_app_state") {
      this.desktopCapture = undefined;
      let pid = args.pid;
      let initial: DriverReply | undefined;
      let bundle = typeof args.bundle === "string" ? args.bundle : undefined;
      if (pid === undefined) {
        const listed = await call("list", {});
        const apps = listed.data.apps as { pid?: number; bundleId?: string; running?: boolean }[];
        const matches = apps.filter(app => app.running && app.bundleId === args.bundle);
        if (matches.length > 1) throw new Error("computer_app_identity_unavailable: 请指定准确进程");
        pid = matches[0]?.pid;
        if (pid === undefined && typeof args.bundle === "string" && legacyAutoLaunch(args) !== false) {
          pid = (await call("launch", { bundleId: args.bundle }, true)).data.pid;
        }
      } else if (args.bundle !== undefined || args.window_id === undefined) {
        initial = await call("list", { pid });
        const apps = Array.isArray(initial.data.apps) ? initial.data.apps as { pid?: number; bundleId?: string; running?: boolean }[] : [];
        const matches = apps.filter(app => app.pid === pid && app.running);
        if (matches.length !== 1 || !matches[0]!.bundleId || (bundle !== undefined && matches[0]!.bundleId !== bundle)) throw new Error("computer_app_identity_unavailable: 应用与指定进程不匹配");
        bundle = matches[0]!.bundleId;
      }
      if (typeof pid !== "number") throw new Error("computer_observation_requires_target: 请指定应用或进程");
      let windowId = args.window_id === undefined ? undefined : String(args.window_id);
      if (!windowId) {
        if (!bundle) throw new Error("computer_app_identity_unavailable: 请指定准确进程");
        windowId = String(await waitForWindow(pid, bundle, async waiting => await call("list", { pid }, false, waiting), signal, initial));
      }
      reply = await call("observe", { pid, windowId, ...legacyObservationOptions(args) });
    } else if (inputs.has(tool)) {
      const capture = this.desktopCapture;
      if (!capture || args.pid !== undefined && args.pid !== capture.pid || args.window_id !== undefined && String(args.window_id) !== capture.windowId) throw new Error("computer_observation_required: 请先观察同一窗口");
      if (args.bundle !== undefined) {
        const listed = await call("list", {});
        const apps = listed.data.apps as { pid?: number; bundleId?: string }[];
        if (!apps.some(app => app.pid === capture.pid && app.bundleId === args.bundle)) throw new Error("computer_app_identity_unavailable: 应用与当前观察不一致");
      }
      this.desktopCapture = undefined;
      reply = await call("action", { ...capture, ...legacyActionPayload(tool, args) }, true);
    } else throw new Error("computer_tool_unsupported");
    if (typeof reply.data.capture_id === "string") this.desktopCapture = { pid: Number(reply.data.pid), windowId: String(reply.data.window_id), captureId: reply.data.capture_id };
    const { elements, ...data } = reply.data;
    const tree = renderElementTree(elements as ElementLike[] | undefined);
    if (tool === "get_app_state") {
      const body = { ...data, error: reply.errorCode, elements: externalElements(elements as ElementLike[] | undefined) };
      return { isError: !!reply.errorCode, structuredContent: body, content: [
        { type: "text", text: JSON.stringify(body) },
        ...(tree ? [{ type: "text" as const, text: tree }] : []),
        ...reply.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.dataBase64 }))
      ] };
    }
    return { isError: !!reply.errorCode, content: [
      { type: "text", text: [JSON.stringify({ ...data, error: reply.errorCode }), tree].filter(Boolean).join("\n") },
      ...reply.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.dataBase64 }))
    ] };
  }

}
