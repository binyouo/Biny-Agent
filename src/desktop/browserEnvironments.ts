import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type BrowserProxyMode = "system" | "direct" | "fixed_servers";

export interface BrowserProxySettings {
  mode: BrowserProxyMode;
  proxyRules?: string;
  proxyBypassRules?: string;
}

export interface BrowserEnvironment {
  id: string;
  name: string;
  color: string;
  proxy: BrowserProxySettings;
}

export interface BrowserEnvironmentInput {
  name: string;
  proxy: BrowserProxySettings;
}

const environmentColors = ["#75c9f2", "#73d9aa", "#d7a4f5", "#f4bd6a", "#f18a91", "#7f9df5"] as const;
const proxySchema = z.object({
  mode: z.enum(["system", "direct", "fixed_servers"]),
  proxyRules: z.string().trim().max(1_000).optional(),
  proxyBypassRules: z.string().trim().max(1_000).optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "fixed_servers" && !value.proxyRules) {
    context.addIssue({ code: "custom", message: "手动代理需要填写代理规则。", path: ["proxyRules"] });
  }
  if ([value.proxyRules, value.proxyBypassRules].some((item) => item?.includes("\n") || item?.includes("\r"))) {
    context.addIssue({ code: "custom", message: "代理规则不能包含换行。" });
  }
  if (value.proxyRules?.includes("@")) {
    context.addIssue({ code: "custom", message: "代理规则不能包含用户名或密码。" });
  }
});

const storedEnvironmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu),
  proxy: proxySchema
}).strict();

export const browserEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  proxy: proxySchema
}).strict();

const defaultEnvironment: BrowserEnvironment = {
  id: "default",
  name: "默认",
  color: "#aeb5c2",
  proxy: { mode: "system" }
};

export class BrowserEnvironmentStore {
  private environments: BrowserEnvironment[] = [];
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    let source: string;
    try {
      source = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = z.array(storedEnvironmentSchema).parse(JSON.parse(source));
    this.assertUniqueNames(parsed);
    this.environments = parsed;
  }

  list(): BrowserEnvironment[] {
    return [{ ...defaultEnvironment, proxy: { ...defaultEnvironment.proxy } }, ...this.environments.map(copyEnvironment)];
  }

  get(idOrName: string): BrowserEnvironment | undefined {
    const normalized = idOrName.trim().toLowerCase();
    const environment = this.list().find((item) => item.id === idOrName || item.name.toLowerCase() === normalized);
    return environment && copyEnvironment(environment);
  }

  async create(input: BrowserEnvironmentInput): Promise<BrowserEnvironment> {
    return await this.mutate(async () => {
      const normalized = validateEnvironmentInput(input);
      this.assertNameAvailable(normalized.name);
      const environment: BrowserEnvironment = {
        id: randomUUID(), name: normalized.name,
        color: environmentColors[this.environments.length % environmentColors.length]!,
        proxy: normalized.proxy
      };
      this.environments.push(environment);
      try { await this.persist(); }
      catch (error) { this.environments.pop(); throw error; }
      return copyEnvironment(environment);
    });
  }

  async update(id: string, input: BrowserEnvironmentInput): Promise<BrowserEnvironment> {
    if (id === "default") throw new Error("默认环境不可修改。");
    return await this.mutate(async () => {
      const index = this.environments.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("浏览器环境不存在。");
      const normalized = validateEnvironmentInput(input);
      this.assertNameAvailable(normalized.name, id);
      const previous = this.environments[index]!;
      const environment = { ...previous, ...normalized };
      this.environments[index] = environment;
      try { await this.persist(); }
      catch (error) { this.environments[index] = previous; throw error; }
      return copyEnvironment(environment);
    });
  }

  async delete(id: string): Promise<void> {
    if (id === "default") throw new Error("默认环境不可删除。");
    await this.mutate(async () => {
      const index = this.environments.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("浏览器环境不存在。");
      const [removed] = this.environments.splice(index, 1);
      try { await this.persist(); }
      catch (error) { this.environments.splice(index, 0, removed!); throw error; }
    });
  }

  private assertNameAvailable(name: string, exceptId?: string): void {
    const normalized = name.toLowerCase();
    if (defaultEnvironment.name.toLowerCase() === normalized
      || this.environments.some((item) => item.id !== exceptId && item.name.toLowerCase() === normalized)) {
      throw new Error("浏览器环境名称已存在。");
    }
  }

  private assertUniqueNames(environments: BrowserEnvironment[]): void {
    const names = new Set<string>([defaultEnvironment.name.toLowerCase()]);
    const ids = new Set<string>();
    for (const environment of environments) {
      const name = environment.name.toLowerCase();
      if (names.has(name) || ids.has(environment.id)) throw new Error("浏览器环境文件包含重复名称或 ID。");
      names.add(name); ids.add(environment.id);
    }
  }

  private async mutate<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(this.environments, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function validateEnvironmentInput(input: BrowserEnvironmentInput): BrowserEnvironmentInput {
  return browserEnvironmentInputSchema.parse({ name: input.name, proxy: input.proxy });
}

function copyEnvironment(environment: BrowserEnvironment): BrowserEnvironment {
  return { ...environment, proxy: { ...environment.proxy } };
}

export function browserPartitionForEnvironment(environmentId: string): string {
  if (environmentId === "default") return "persist:biny-browser";
  if (!z.string().uuid().safeParse(environmentId).success) throw new Error("浏览器环境 ID 无效。");
  return `persist:biny-browser-env-${environmentId}`;
}
