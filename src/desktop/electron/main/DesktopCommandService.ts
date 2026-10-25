import path from "node:path";
import { z } from "zod";
import { readSetting, writeSetting } from "../../../config/settingPath.js";
import type { AppearancePreviewCoordinator } from "../../appearanceCoordinator.js";
import type { DesktopAgentManager } from "./DesktopAgentManager.js";
import type { DesktopProjectService } from "./DesktopProjectService.js";
import type { DesktopStateStore } from "./DesktopStateStore.js";
import type { DesktopTerminalManager } from "./DesktopTerminalManager.js";
import type { DesktopPreviewService } from "./DesktopPreviewService.js";
import { configRevisionSchema, fontPreferenceSchema, idSchema, themePreferenceSchema } from "./settingsSaveInputSchema.js";
import { appearancePreferenceSchema } from "../../../appearance/preferences.js";
import { executeConfigurationCommand } from "../../../config/commands.js";
import type { AgentConfigStore } from "../../../config/store.js";
import type { DesktopBrowserService } from "./DesktopBrowserService.js";
import { browserEnvironmentInputSchema } from "../../browserEnvironments.js";

interface DesktopCommandServices {
  state: DesktopStateStore;
  projects: DesktopProjectService;
  agents: DesktopAgentManager;
  terminals: DesktopTerminalManager;
  preview: DesktopPreviewService;
  appearance: AppearancePreviewCoordinator;
  configStore: AgentConfigStore;
  browser: DesktopBrowserService;
}

const preferencesSchema = z.object({ themePreference: themePreferenceSchema, fontPreference: fontPreferenceSchema, appearancePreference: appearancePreferenceSchema }).strict();
const nameSchema = z.string().trim().min(1).max(240);

export class DesktopCommandService {
  constructor(private readonly services: DesktopCommandServices) {}

  async execute(args: Record<string, unknown>): Promise<unknown> {
    const { state, projects, agents, terminals, preview, appearance, browser } = this.services;
    const action = z.string().parse(args.action);
    if (action === "configuration") {
      return await executeConfigurationCommand(this.services.configStore, z.string().parse(args.operation), z.record(z.string(), z.unknown()).parse(args.input));
    }
    if (action === "project.list") return { projects: await projects.refreshAllProjects() };
    if (action === "browser.profile.list") return await browser.listProfiles();
    if (action === "browser.profile.import") return await browser.importProfile(z.string().parse(args.id));
    if (action === "browser.env.create" || action === "browser.env.update") {
      const input = browserEnvironmentInputSchema.parse(args.input);
      return action === "browser.env.create" ? await browser.createBrowserEnvironment(input) : await browser.updateBrowserEnvironment(z.string().parse(args.id), input);
    }
    if (action === "browser.env.delete" || action === "browser.env.clear") {
      const id = z.string().parse(args.id);
      if (action === "browser.env.delete") await browser.deleteBrowserEnvironment(id);
      else await browser.clearBrowserEnvironment(id);
      return { id };
    }
    if (action === "browser.env.import-cookies") return await browser.importBrowserEnvironmentCookies(z.string().parse(args.source), z.string().parse(args.target));
    if (action === "project.add" || action === "project.create") {
      const directory = z.string().min(1).parse(args.path);
      return action === "project.add" ? await projects.createProject(directory) : await projects.createEmptyProject(directory);
    }
    if (action === "preferences.get" || action === "preferences.set") {
      const key = z.string().parse(args.path);
      const previous = state.settingsPreferences();
      const current = { themePreference: previous.themePreference, fontPreference: previous.fontPreference, appearancePreference: previous.appearancePreference };
      if (action === "preferences.get") return readSetting(current, key);
      const next = preferencesSchema.parse(writeSetting(current, key, args.value));
      readSetting(next, key);
      await state.applySettingsPreferences(next, previous.revision);
      appearance.committed();
      return { path: key, value: readSetting(next, key) };
    }
    const projectId = args.projectId === undefined
      ? state.projects().find(project => project.path === path.resolve(z.string().parse(args.workspaceRoot)))?.id
      : idSchema.parse(args.projectId);
    if (!projectId) throw new Error("The current directory is not registered in Desktop. Use biny project add <path>.");
    const project = projects.requireProject(projectId);
    switch (action) {
      case "browser.tab.list": return browser.browserSnapshot(project.id);
      case "browser.tab.action": return await browser.applyBrowserAction(project.id, args.input);
      case "project.show": return project;
      case "project.rename":
        await agents.renameProject(project.id, nameSchema.parse(args.name));
        return state.project(project.id);
      case "project.remove":
        await agents.removeProject(project.id);
        return { removed: project.id };
      case "session.rename": {
        const sessionId = idSchema.parse(args.sessionId);
        const title = nameSchema.parse(args.title);
        await agents.renameSession(project.id, sessionId, title, configRevisionSchema.optional().parse(args.revision));
        return { projectId: project.id, sessionId, title };
      }
      case "session.delete": {
        const result = await agents.deleteSessions([{ projectId: project.id, sessionId: idSchema.parse(args.sessionId) }]);
        if (result.failures.length) throw new Error(result.failures[0]!.error);
        return result;
      }
      case "session.pin":
      case "session.unpin":
        return await agents.pinSession(project.id, idSchema.parse(args.sessionId), action === "session.pin", configRevisionSchema.optional().parse(args.revision));
      case "session.archive":
      case "session.unarchive":
        return await agents.archiveSession(project.id, idSchema.parse(args.sessionId), action === "session.archive", configRevisionSchema.optional().parse(args.revision));
      case "session.duplicate": return await agents.duplicateSession(project.id, idSchema.parse(args.sessionId));
      case "preview.detect": return await projects.projectPreviewAvailability(project.id);
      case "preview.start": return await preview.start(project.id, z.string().min(1).max(2_000).optional().parse(args.entry));
      case "preview.status": return preview.status(project.id);
      case "preview.stop": return await preview.stop(project.id);
      case "terminal.list": return { terminals: terminals.list(project.id) };
      case "terminal.create":
        if (project.missing) throw new Error("项目目录不可用，无法打开终端。");
        return await terminals.create(project.id, project.path, 80, 24, nameSchema.parse(args.name));
      case "terminal.read":
      case "terminal.write":
      case "terminal.close": {
        const terminalId = idSchema.parse(args.terminalId);
        if (!terminals.list(project.id).some(terminal => terminal.terminalId === terminalId)) throw new Error("Terminal does not belong to this project.");
        if (action === "terminal.read") return terminals.read(terminalId);
        if (action === "terminal.write") terminals.write(terminalId, z.string().max(1_000_000).parse(args.text));
        else terminals.dispose(terminalId);
        return { terminalId, [action === "terminal.write" ? "written" : "closed"]: true };
      }
      default: throw new Error(`Unknown Desktop command: ${action}`);
    }
  }
}
