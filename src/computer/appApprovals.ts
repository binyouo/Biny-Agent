import { updateConfig, type AgentConfigStore } from "../config/store.js";
import { computerAppSchema, type ComputerAppApproval } from "./protocol.js";

/** 应用身份来自本机进程目录；审批与工具权限独立，写入统一配置 CAS。 */
export class ComputerAppApprovals {
  constructor(private readonly store: AgentConfigStore) {}
  async read() { return (await this.store.load()).computer; }
  async setStrict(strictApproval: boolean): Promise<void> {
    await updateConfig(this.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval } }));
  }
  async approve(bundleId: string): Promise<void> { await this.updateKnown(bundleId, app => ({ ...app, approvedAt: new Date().toISOString(), revokedAt: undefined })); }
  async revoke(bundleId: string): Promise<void> { await this.updateKnown(bundleId, app => ({ ...app, revokedAt: new Date().toISOString() })); }
  private async updateKnown(bundleId: string, update: (app: ComputerAppApproval) => ComputerAppApproval): Promise<void> {
    await updateConfig(this.store, undefined, config => {
      if (!config.computer.apps.some(app => app.bundleId === bundleId)) throw new Error("computer_unknown_app");
      return { ...config, computer: { ...config.computer, apps: config.computer.apps.map(app => app.bundleId === bundleId ? update(app) : app) } };
    });
  }
  async authorize(identity: Pick<ComputerAppApproval, "bundleId" | "appName">): Promise<void> {
    const known = computerAppSchema.parse(identity);
    const config = await updateConfig(this.store, undefined, config => {
      const previous = config.computer.apps.find(app => app.bundleId === known.bundleId);
      const approved = previous?.approvedAt !== undefined && previous.revokedAt === undefined;
      const now = new Date().toISOString();
      const allowed = approved || !config.computer.strictApproval;
      const app: ComputerAppApproval = { ...known, ...previous, appName: known.appName,
        approvedAt: allowed && !approved ? now : previous?.approvedAt,
        revokedAt: allowed ? undefined : previous?.revokedAt,
        lastUsedAt: allowed ? now : previous?.lastUsedAt,
        useCount: (previous?.useCount ?? 0) + (allowed ? 1 : 0) };
      if (!previous && config.computer.apps.length >= 256) throw new Error("computer_app_approval_limit");
      return { ...config, computer: { ...config.computer, apps: previous ? config.computer.apps.map(value => value.bundleId === app.bundleId ? app : value) : [...config.computer.apps, app] } };
    });
    const app = config.computer.apps.find(app => app.bundleId === known.bundleId)!;
    if (!app.approvedAt || app.revokedAt) throw new Error(`computer_app_approval_required: ${app.appName} (${app.bundleId}); 请在设置 → Computer Use → 应用授权中批准后重试。`);
  }
}
