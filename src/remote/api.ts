import { z } from "zod";
import type { RuntimeHostClient } from "../runtime/host/client.js";
import type { InteractiveRuntimeSnapshot, PendingPermissionSnapshot } from "../runtime/agentEvents.js";
import { querySessionCatalog } from "../session/catalog.js";
import { readSessionMessages } from "../session/inspection.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";

const sessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u);
const projectId = z.string().min(1).max(200);
export const remoteRequestSchema = z.discriminatedUnion("method", [
  z.object({ id: z.string().uuid(), method: z.literal("projects") }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("sessions"), projectId, cursor: z.string().max(2048).optional() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("open"), projectId, sessionId }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("create"), projectId }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("history"), sessionId, offset: z.number().int().min(0).optional() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("send"), sessionId, text: z.string().trim().min(1).max(32_000) }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("cancel"), sessionId, runId: z.string().uuid() }).strict(),
  z.object({ id: z.string().uuid(), method: z.literal("permission"), sessionId, requestId: z.string().min(1).max(200), approved: z.boolean(), confirmation: z.string().max(10).optional() }).strict()
]);
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;
export interface RemoteView {
  sessionId: string;
  model: string;
  state: { kind: "idle" | "maintenance" } | { kind: "runs"; activeRun: { runId: string }; pendingPermission?: PendingPermissionSnapshot };
}

function view(snapshot: InteractiveRuntimeSnapshot): RemoteView {
  const state = snapshot.state;
  return redactSensitiveValue({ sessionId: snapshot.info.sessionId, model: snapshot.info.modelLabel,
    state: state.kind === "runs" ? { kind: state.kind, activeRun: { runId: state.activeRun.runId }, pendingPermission: state.pendingPermission } : { kind: state.kind } }) as RemoteView;
}

export interface RemotePeerApi {
  handle(request: RemoteRequest): Promise<unknown>;
  close(): void | Promise<void>;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
  path: string;
  /** 会话持久化根；列会话只读数据目录，不需要启动 Host。 */
  workspaceRoot: string;
}
export interface RemoteHostProvider {
  /** 手机端可访问的项目清单。 */
  list(): Promise<RemoteWorkspace[]>;
  /** 按需接入某项目的 RuntimeHost。 */
  attach(projectId: string): Promise<{ workspaceRoot: string; client: RuntimeHostClient }>;
}

/** 每个已认证手机独立选择项目与会话；各项目 Host 按需接入，所有写入仍由对应 Host 仲裁。 */
export function createRemotePeerApi(provider: RemoteHostProvider, emit: (value: unknown) => void): RemotePeerApi {
  let selected: { sessionId: string; workspaceRoot: string; client: RuntimeHostClient } | undefined;
  let closed = false;
  const attachments = new Map<string, Promise<{ workspaceRoot: string; client: RuntimeHostClient }>>();
  const releases: Array<() => void> = [];
  const attach = (id: string): Promise<{ workspaceRoot: string; client: RuntimeHostClient }> => {
    if (closed) return Promise.reject(new Error("Remote peer is closed."));
    let pending = attachments.get(id);
    if (!pending) {
      pending = provider.attach(id).then(async entry => {
        if (closed) {
          await entry.client.close().catch(() => undefined);
          throw new Error("Remote peer is closed.");
        }
        releases.push(entry.client.subscribeAllRuntimeEvents(update => {
          if (selected?.client !== entry.client || update.snapshot.info.sessionId !== selected.sessionId) return;
          const event = update.event;
          if (event && ["assistant.delta", "reasoning.delta", "tool.progress"].includes(event.type)) return;
          emit({ t: "update", view: view(update.snapshot), event: event?.type });
        }));
        return entry;
      });
      attachments.set(id, pending);
      // 接入失败要允许手机端重试，不能把这个项目永久钉在失败结果上。
      void pending.catch(() => { if (attachments.get(id) === pending) attachments.delete(id); });
    }
    return pending;
  };
  return {
    async close() {
      if (closed) return;
      closed = true;
      selected = undefined;
      for (const release of releases.splice(0)) release();
      const pending = [...attachments.values()];
      attachments.clear();
      // 已接入的 client 在这里关闭；仍在 attach 中的由上方 then 分支看到 closed 后自行关闭。
      await Promise.allSettled(pending.map(async entry => { const attached = await entry.catch(() => undefined); if (attached) await attached.client.close(); }));
    },
    async handle(request) {
      if (request.method === "projects") {
        const items = await provider.list();
        return { items: items.map(({ id, name, path }) => ({ id, name, path })) };
      }
      if (request.method === "sessions") {
        const workspace = (await provider.list()).find(item => item.id === request.projectId);
        if (!workspace) throw new Error("Unknown project.");
        const page = await querySessionCatalog(workspace.workspaceRoot, { limit: 20, cursor: request.cursor });
        return { items: page.items.map(item => ({ id: item.id, title: redactSecrets(item.title ?? item.summary.firstUserMessage ?? item.id).slice(0, 160) })), nextCursor: page.nextCursor, revisionChanged: page.revisionChanged };
      }
      if (request.method === "open" || request.method === "create") {
        const attached = await attach(request.projectId);
        const result = await attached.client.ensureSession({ sessionId: request.method === "open" ? request.sessionId : undefined, focus: false });
        selected = { sessionId: result.sessionId, workspaceRoot: attached.workspaceRoot, client: attached.client };
        return view(result.snapshot);
      }
      if (!selected || request.sessionId !== selected.sessionId) throw new Error("Session selection changed. Select the session again before continuing.");
      const active = selected;
      if (request.method === "history") {
        const page = await readSessionMessages(active.workspaceRoot, active.sessionId, { offset: request.offset ?? 0, limit: 20, full: true, fromEnd: request.offset === undefined });
        return { ...page, messages: page.messages.map(({ parts: _parts, ...message }) => message) };
      }
      if (request.method === "send") return await active.client.submitRunForSession(active.sessionId, request.text, [], { runId: request.id, messageId: request.id, turnId: request.id });
      if (request.method === "cancel") return await active.client.cancelRunRequest(request.runId, "cancelled", active.sessionId);
      return await active.client.answerPermissionRequest(request.requestId, { approved: request.approved, confirmation: request.confirmation }, active.sessionId);
    }
  };
}
