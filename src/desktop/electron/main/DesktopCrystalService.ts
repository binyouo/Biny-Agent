/** 桌面结晶入口：按需打开共享存储，用全局辅助模型处理材料，不启动聊天 Runtime。 */
import type { AgentConfigStore } from "../../../config/store.js";
import { CrystalService } from "../../../agent/context/crystalService.js";
import { CrystalStorage } from "../../../agent/context/crystalStorage.js";
import { resolveToolModel } from "../../../llm/toolModel.js";
import { readSessionEvents } from "../../../session/events.js";
import { resolveSessionFile, sessionIdFromFile } from "../../../session/store.js";
import { activeSessionMessageIds, sessionMessageTree } from "../../../session/messageTree.js";
import { redactSecrets } from "../../../utils/secrets.js";
import { ActivityStore } from "../../../activity/store.js";
import { globalAgentDir } from "../../../config/paths.js";
import { desktopCrystalRequestSchema, type DesktopCrystalRequest, type DesktopCrystalSnapshot } from "../../crystalProtocol.js";

export class DesktopCrystalService {
  constructor(
    private readonly configStore: AgentConfigStore,
    private readonly sessionRoots: () => Promise<string[]>,
    private readonly createStorage: () => CrystalStorage = () => new CrystalStorage()
  ) {}

  async request(input: DesktopCrystalRequest): Promise<DesktopCrystalSnapshot> {
    const request = desktopCrystalRequestSchema.parse(input);
    const config = await this.configStore.load();
    const threads = new Map<string, ReturnType<DesktopCrystalService["readThread"]>>();
    let activityStore: ActivityStore | undefined;
    let activityReady: Promise<void> | undefined;
    const service = new CrystalService({
      storage: this.createStorage(),
      getConfig: () => config.crystal,
      getModel: () => resolveToolModel(config),
      readAnchorText: async ({ threadId, anchorId }) => {
        if (!threadId) return undefined;
        if (threadId.startsWith("activity:") && anchorId.startsWith("activity:")) {
          if (!activityStore) {
            activityStore = new ActivityStore();
            activityReady = activityStore.open(config.activity.outputDirectory, globalAgentDir());
          }
          await activityReady;
          const analysis = activityStore.getAnalysis(anchorId.slice("activity:".length));
          return analysis ? [analysis.title, analysis.summary, ...analysis.highlights, ...analysis.decisions].filter(Boolean).join("\n") : undefined;
        }
        let thread = threads.get(threadId);
        if (!thread) { thread = this.readThread(threadId); threads.set(threadId, thread); }
        const node = (await thread).find((entry) => entry.id === anchorId);
        if (!node) return undefined;
        return typeof node.message.content === "string" ? node.message.content
          : node.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      }
    });
    await service.initialize();
    try {
      let selected = "id" in request ? request.id : undefined;
      switch (request.action) {
        case "overview": break;
        case "detail":
          if (!service.detail(request.id)) throw new Error("结晶不存在或已被移除。");
          break;
        case "seed": {
          const anchors = request.sessionId ? (await this.readThread(request.sessionId)).slice(-30).map((node) => node.id) : undefined;
          selected = service.createSeed(request.name, { threadId: request.sessionId, anchorIds: anchors }).id;
          break;
        }
        case "type": service.setType(request.id, request.type); break;
        case "slot": service.setSlot(request.id, request.slot); break;
        case "dormant": service.setDormant(request.id, request.dormant); break;
        case "checklist": {
          service.storage.transaction(() => {
            for (const [field, patch] of Object.entries(request.fields)) {
              const current = service.detail(request.id)?.crystal.checklist[field];
              service.updateChecklist(request.id, field, {
                value: redactSecrets(patch.value),
                sources: current?.value === patch.value ? current.sources : ["user:manual"],
                conflict: patch.conflict
              });
            }
          });
          break;
        }
        case "note": service.addMaterial(request.id, "note", { text: redactSecrets(request.text) }); break;
        case "prefill": await service.prefill(request.id); break;
        case "confirm": service.confirm(request.id, { name: request.name }); break;
      }
      const detail = selected ? service.detail(selected) : undefined;
      const materialPreviews: Record<number, string> = {};
      if (detail) {
        for (const material of detail.materials) {
          const text = await service.readMaterialText(material);
          if (text) materialPreviews[material.id] = text.slice(0, 1600);
        }
      }
      return { overview: service.overview(), detail: detail ? { ...detail, materialPreviews } : undefined };
    } finally {
      service.close();
      await activityStore?.close();
    }
  }

  private async readThread(sessionId: string): Promise<ReturnType<typeof sessionMessageTree>> {
    // 只在应用登记的项目存储内按完整会话 ID 查找，Renderer 不能传任意磁盘路径。
    for (const root of await this.sessionRoots()) {
      const file = await resolveSessionFile(root, sessionId).catch(() => undefined);
      if (!file || sessionIdFromFile(file) !== sessionId) continue;
      const events = await readSessionEvents(file);
      const active = activeSessionMessageIds(events);
      return sessionMessageTree(events).filter((node) => active.has(node.id)
        && (node.message.role === "user" || node.message.role === "assistant"));
    }
    throw new Error("找不到材料所属的会话。");
  }
}
