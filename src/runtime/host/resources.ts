/**
 * Runtime Host 级共享扩展资源。
 *
 * MCP 连接和 Skill 元数据不是 session 状态：同一个 workspace 的多个 session
 * 应复用它们，但不同 workspace 或有效配置不能互相污染。能力目录和 readiness 以
 * revision 快照发布；慢速资源可以在对话已入账后继续加载。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentConfig } from "../../config/schema.js";
import { createProjectSkillKey } from "../../extensions/skillRef.js";
import { createMcpResourceTools, McpToolHost, type McpServerStatus } from "../../extensions/mcp.js";
import { createMcpPromptTools } from "../../extensions/mcpPrompts.js";
import { loadSkills, type SkillBundle, type SkillDefinition } from "../../extensions/skills.js";
import type { Tool } from "../../tools/types.js";

export type RuntimeResourceState = "loading" | "ready" | "degraded";

export interface RuntimeResourceSnapshot {
  revision: number;
  state: RuntimeResourceState;
  mcp: {
    servers: McpServerStatus[];
    pending: boolean;
  };
  skills: {
    skills: SkillDefinition[];
    warnings: string[];
  };
}

/** 高频运行快照只需要就绪状态；能力目录通过 skills / mcp 查询读取。 */
export type RuntimeResourceReadiness = Pick<RuntimeResourceSnapshot, "revision" | "state">;

export interface McpDiscoveryReadiness {
  servers: McpServerStatus[];
  pending: string[];
  timedOut: boolean;
}

const defaultSkillBundle: SkillBundle = { skills: [], paths: [], prompt: "", warnings: [], conflicts: [], errors: [] };
const mcpBaselineBudgetMs = 10_000;
const skillCacheTtlMs = 30_000;

export class RuntimeHostResourceScope {
  private readonly listeners = new Set<(snapshot: RuntimeResourceSnapshot) => void>();
  private readonly mcpHost = new McpToolHost();
  private skillBundle: SkillBundle = defaultSkillBundle;
  private skillsReady = false;
  private state: RuntimeResourceState = "loading";
  private revision = 0;
  private mcpPending = false;
  private baselinePromise: Promise<void> | undefined;
  private skillRefreshPromise: Promise<void> | undefined;
  private skillsLoadedAt: number | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly discoveryClosed = new AbortController();
  private references = 0;

  constructor(
    readonly workspaceRoot: string,
    private readonly config: AgentConfig,
  ) {
    this.mcpHost.subscribe(() => {
      this.refreshState();
      this.publish();
    });
  }

  get mcp(): McpToolHost {
    return this.mcpHost;
  }

  get skills(): SkillBundle {
    return this.skillBundle;
  }

  retain(): void {
    this.references += 1;
  }

  release(): boolean {
    if (this.references === 0) return false;
    this.references -= 1;
    return this.references === 0;
  }

  start(): Promise<void> {
    if (this.baselinePromise) return this.baselinePromise;
    const skillPromise = this.refreshSkills().then(() => {
      this.skillsReady = true;
      this.refreshState();
      this.publish();
    });
    const mcpPromise = this.startMcp();
    this.baselinePromise = Promise.all([skillPromise, mcpPromise]).then(
      () => {
        this.refreshState();
        this.publish();
      },
      () => {
        // 资源异常不能把普通对话永久卡在 loading；失败能力由 MCP/Skill 状态继续说明。
        this.state = "degraded";
        this.publish();
      }
    );
    return this.baselinePromise;
  }

  snapshot(): RuntimeResourceSnapshot {
    return {
      revision: this.revision,
      state: this.state,
      mcp: {
        servers: this.mcpHost.listServers(),
        pending: this.mcpPending,
      },
      skills: {
        skills: [...this.skillBundle.skills],
        warnings: [...this.skillBundle.warnings],
      },
    };
  }

  readiness(): RuntimeResourceReadiness {
    return { revision: this.revision, state: this.state };
  }

  subscribe(listener: (snapshot: RuntimeResourceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createTools(): Tool[] {
    return this.mcpHost.createTools();
  }

  async waitForMcpDiscovery(input: { query?: string; signal?: AbortSignal } = {}): Promise<McpDiscoveryReadiness> {
    input.signal?.throwIfAborted();
    if (this.discoveryClosed.signal.aborted) throw new Error("MCP resource scope is closed.");
    const servers = this.mcpHost.listServers();
    const targets = referencedMcpServers(servers, input.query);
    for (const server of servers) {
      const config = this.config.extensions.mcp[server.name];
      if (config?.exposure === "hidden" && !Object.values(config.toolExposure ?? {}).some((exposure) => exposure !== "hidden")) targets.delete(server.name);
    }
    const readiness = (timedOut = false): McpDiscoveryReadiness => {
      const current = this.mcpHost.listServers().filter((server) => targets.has(server.name));
      return {
        servers: current,
        pending: current.filter((server) => server.enabled && !server.connected && server.connecting).map((server) => server.name),
        timedOut,
      };
    };
    const current = readiness();
    if (!current.pending.length) return current;
    return await new Promise<McpDiscoveryReadiness>((resolve, reject) => {
      let settled = false;
      const finish = (result?: McpDiscoveryReadiness, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        input.signal?.removeEventListener("abort", cancelled);
        this.discoveryClosed.signal.removeEventListener("abort", closed);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const cancelled = (): void => finish(undefined, input.signal?.reason ?? new DOMException("Discovery was cancelled.", "AbortError"));
      const closed = (): void => finish(undefined, new Error("MCP resource scope is closed."));
      const check = (): void => {
        const next = readiness();
        if (!next.pending.length) finish(next);
      };
      const unsubscribe = this.subscribe(check);
      const timer = setTimeout(() => finish(readiness(true)), mcpBaselineBudgetMs);
      input.signal?.addEventListener("abort", cancelled, { once: true });
      this.discoveryClosed.signal.addEventListener("abort", closed, { once: true });
      if (input.signal?.aborted) cancelled();
      else if (this.discoveryClosed.signal.aborted) closed();
      else check();
    });
  }

  createResourceTools(): Tool[] {
    return this.mcpHost.hasEnabledServers() ? [...createMcpResourceTools(this.mcpHost), ...createMcpPromptTools(this.mcpHost)] : [];
  }

  refreshSkills(force = false): Promise<void> {
    // 安装后必须看到新文件；若旧扫描仍在进行，先等它完成再强制刷新。
    if (force && this.skillRefreshPromise) return this.skillRefreshPromise.then(() => this.refreshSkills(true));
    if (this.skillRefreshPromise) return this.skillRefreshPromise;
    if (!force && this.skillsLoadedAt !== undefined && Date.now() - this.skillsLoadedAt < skillCacheTtlMs) return Promise.resolve();
    // 同一 workspace 短期复用目录；显式安装绕过缓存，外部编辑最迟下一次过期刷新可见。
    this.skillRefreshPromise ??= this.loadSkillBundle().finally(() => { this.skillRefreshPromise = undefined; });
    return this.skillRefreshPromise;
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.discoveryClosed.abort();
    this.closePromise = this.mcpHost.close();
    await this.closePromise;
  }

  private async loadSkillBundle(): Promise<void> {
    let nextBundle: SkillBundle;
    try {
      nextBundle = await loadSkills({
        workspaceRoot: this.workspaceRoot,
        projectPaths: this.config.extensions.skills,
        globalDefaults: this.config.extensions.skillDefaults,
        projectOverrides: this.config.extensions.skillProjectOverrides[createProjectSkillKey(this.workspaceRoot)],
      });
    } catch (error) {
      nextBundle = {
        ...defaultSkillBundle,
        warnings: [error instanceof Error ? error.message : String(error)],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (JSON.stringify(nextBundle) !== JSON.stringify(this.skillBundle)) {
      this.skillBundle = nextBundle;
      this.refreshState();
      this.publish();
    }
    this.skillsLoadedAt = nextBundle.errors.length ? undefined : Date.now();
  }

  private async startMcp(): Promise<void> {
    this.mcpPending = Object.values(this.config.extensions.mcp).some((server) => server.enabled);
    this.publish();
    const connecting = this.mcpHost.connectConfiguredServers(this.workspaceRoot, this.config);
    if (!this.mcpPending) {
      await connecting;
      return;
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      connecting.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
        timedOut = true;
        resolve(false);
        }, mcpBaselineBudgetMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!finished && timedOut) {
      this.mcpPending = true;
      this.refreshState();
      this.publish();
      void connecting.then(
        () => {
          this.mcpPending = false;
          this.refreshState();
          this.publish();
        },
        () => {
          this.mcpPending = false;
          this.state = "degraded";
          this.publish();
        },
      );
      return;
    }
    this.mcpPending = false;
  }

  private isDegraded(): boolean {
    return this.skillBundle.errors.length > 0
      || this.mcpHost.listServers().some((server) => server.enabled && !server.connected && !server.connecting);
  }

  private refreshState(): void {
    if (!this.skillsReady) return;
    this.state = this.isDegraded() ? "degraded" : "ready";
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export class RuntimeHostResourceRegistry {
  private readonly scopes = new Map<string, RuntimeHostResourceScope>();

  acquire(workspaceRoot: string, config: AgentConfig): RuntimeHostResourceScope {
    const key = resourceScopeKey(workspaceRoot, config);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = new RuntimeHostResourceScope(path.resolve(workspaceRoot), config);
      this.scopes.set(key, scope);
    }
    scope.retain();
    return scope;
  }

  async release(scope: RuntimeHostResourceScope): Promise<void> {
    const entry = [...this.scopes.entries()].find(([, candidate]) => candidate === scope);
    if (!entry || !scope.release()) return;
    this.scopes.delete(entry[0]);
    await scope.close();
  }

  async close(): Promise<void> {
    const scopes = [...this.scopes.values()];
    this.scopes.clear();
    await Promise.all(scopes.map((scope) => scope.close()));
  }
}

function resourceScopeKey(workspaceRoot: string, config: AgentConfig): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      mcp: config.extensions.mcp,
      skills: config.extensions.skills,
      skillDefaults: config.extensions.skillDefaults,
      skillProjectOverrides: config.extensions.skillProjectOverrides,
    }))
    .digest("hex");
  return `${path.resolve(workspaceRoot)}\0${digest}`;
}

function referencedMcpServers(servers: McpServerStatus[], query?: string): Set<string> {
  const referenced = new Set<string>();
  const tokens = query?.trim().split(/[\s,;()，；]+/u) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^[`'"[]+|[`'"\]]+$/gu, "");
    const matches = servers.map((server) => {
      const normalized = server.name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42) || "tool";
      const exact = token === server.name || token === `mcp:${server.name}` || token === `mcp_${normalized}`;
      const specificity = exact ? Infinity : token.startsWith(`${server.name}.`) ? server.name.length
        : token.startsWith(`mcp_${normalized}_`) ? normalized.length : 0;
      return { server, specificity };
    }).filter((match) => match.specificity > 0);
    // 前缀重叠时，工具名只指向最具体的服务器；泛化语义查询仍等待全部未决连接。
    const longest = Math.max(...matches.map((match) => match.specificity));
    for (const { server } of matches.filter((match) => match.specificity === longest)) referenced.add(server.name);
  }
  return referenced.size ? referenced : new Set(servers.map((server) => server.name));
}
