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
  run(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>): Promise<CallToolResult>;
}
const inputs = new Set(["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"]);
/** MCP 和 Desktop 共用启用选择、应用审批与日志；没有 Desktop 时仍执行同一策略。 */
export class LocalComputerMcpPolicy implements ComputerMcpPolicy {
  private readonly approvals: ComputerAppApprovals;
  private last?: WindowTarget;
  private readonly transportId = `mcp:${randomUUID()}`;
  private desktopMirrors = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly driver: NativeProcessDriver, private readonly store: AgentConfigStore = createFileConfigStore(globalAgentDir()),
    private readonly audit = new ComputerAuditStore(path.join(globalConfigDir(), "computer-actions.sqlite")),
    private readonly notify: (target: WindowTarget) => Promise<void> = notifyDesktopComputerActivity) { this.approvals = new ComputerAppApprovals(store); }
  run(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const result = this.tail.then(() => this.execute(tool, args, operation)); this.tail = result.catch(() => undefined); return result;
  }
  async close(): Promise<void> {
    await this.tail;
    try { const desktop = this.desktopMirrors ? await computerDesktopConnection() : undefined; if (desktop) await requestComputer(desktop, "release", { session: this.transportId }); }
    finally { this.audit.close(); }
  }
  private async execute(tool: string, args: Record<string, unknown>, operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
    if (["permissions", "grant"].includes(tool)) return await operation();
    if (tool.startsWith("pip_")) {
      const desktop = await computerDesktopConnection();
      if (desktop) {
        const operation = tool.slice(4), reply = await requestComputer(desktop, "mirror", { operation, session: this.transportId, pid: args.pid, windowId: args.window_id === undefined ? undefined : String(args.window_id), onMinimize: args.on_minimize, all: args.all });
        if (operation === "open") this.desktopMirrors = true;
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
    if (inputs.has(tool) && (!this.last || this.last.pid !== pid || args.window_id !== undefined && String(args.window_id) !== this.last.windowId)) throw new Error("computer_observation_required: observe the exact target before input");
    if (inputs.has(tool) && this.last) { args.pid = this.last.pid; args.window_id = Number(this.last.windowId); }
    const at = Date.now(); let result: CallToolResult;
    try { result = await operation(); }
    catch (error) {
      if (inputs.has(tool) && config.computer.actionLogging && this.last) { try { this.audit.append({ at, action: tool as ComputerAction["action"], target: this.last, outcome: "unknown", durationMs: Date.now() - at, bundleId: identity.bundleId, errorCode: error instanceof Error ? error.message : String(error) }); } catch { throw new AggregateError([error], "computer_outcome_unknown: input may have been dispatched and its log could not be saved; do not repeat"); } }
      throw error;
    }
    const text = result.content.find(part => part.type === "text");
    if (tool === "get_app_state" && !result.isError && text?.type === "text") {
      // 观察的 JSON 是多行文本，后面可附树和说明书。
      const match = text.text.match(/"window_id"\s*:\s*(\d+)|"windowId"\s*:\s*(\d+)/);
      const observedPid = text.text.match(/"pid"\s*:\s*(\d+)/)?.[1];
      if (observedPid && match) this.last = { pid: Number(observedPid), windowId: match[1] ?? match[2]! };
      else this.last = undefined;
    }
    if (inputs.has(tool) && this.last) {
      const outcome = result.isError ? /timeout|disconnect|aborted|unknown/i.test(text?.type === "text" ? text.text : "") ? "unknown" : "refused" : /verification_note|warning/.test(text?.type === "text" ? text.text : "") ? "unverified" : "completed";
      if (config.computer.actionLogging) { try { this.audit.append({ at, action: tool as ComputerAction["action"], target: this.last, outcome, durationMs: Date.now() - at, bundleId: identity.bundleId, errorCode: result.isError && text?.type === "text" ? text.text : undefined }); } catch { result.content.push({ type: "text", text: "The input was already dispatched, but the action log could not be saved. Do not repeat it." }); } }
      if (outcome !== "refused") { try { await this.notify(this.last); } catch { result.content.push({ type: "text", text: "Desktop preview notification failed. The input was already dispatched; do not repeat it." }); } }
    }
    return result;
  }
}
