import type { DesktopProjectService } from "./DesktopProjectService.js";
import type { DesktopTerminalManager } from "./DesktopTerminalManager.js";
import type { StaticPreviewServer } from "./StaticPreviewServer.js";

export class DesktopPreviewService {
  constructor(private readonly projects: DesktopProjectService, private readonly terminals: DesktopTerminalManager, private readonly staticPreview: StaticPreviewServer) {}

  async start(projectId: string, entry?: string) {
    const project = this.projects.requireProject(projectId);
    const running = this.staticPreview.status(project.id);
    if (running) return { kind: "static" as const, url: running.url };
    const availability = await this.projects.projectPreviewAvailability(project.id);
    if (!availability.available) throw new Error(availability.reason);
    if ("kind" in availability) {
      const selected = entry ?? availability.entry;
      if (!availability.entries.includes(selected)) throw new Error("所选 HTML 入口已失效，请重新选择。");
      const result = await this.staticPreview.start(project.id, project.path, selected);
      this.terminals.clearPreviewFailure(project.id);
      return { kind: "static" as const, ...result };
    }
    return { kind: "script" as const, ...(await this.terminals.startPreview(project.id, project.path, availability.command)), command: availability.command };
  }

  status(projectId: string) {
    const project = this.projects.requireProject(projectId);
    const running = this.staticPreview.status(project.id);
    if (running) return { kind: "static" as const, url: running.url };
    const status = this.terminals.previewStatus(project.id);
    return status.kind === "running" ? { kind: "script" as const, terminalId: status.terminalId, url: status.url } : status;
  }

  async stop(projectId: string): Promise<{ stopped: true }> {
    this.projects.requireProject(projectId);
    const terminalId = this.terminals.list(projectId).find(entry => entry.slotId === "preview")?.terminalId;
    if (terminalId) this.terminals.dispose(terminalId);
    this.terminals.clearPreviewFailure(projectId);
    await this.staticPreview.stop(projectId);
    return { stopped: true };
  }
}
