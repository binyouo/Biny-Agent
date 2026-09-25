/** 已有配置、Crystal 与 Host authority 的对象可引用；消失后不能继续解析，敏感配置不外露。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { LocalReferenceService, parseLocalReferenceUri } from "../src/session/localReferences.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-kinds-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  const config = structuredClone(defaultConfig);
  config.providers.fixture = { type: "openai-compatible", apiKey: "SECRET_KEY_MUST_NOT_LEAK", baseUrl: "https://example.invalid" };
  config.models.fixture = { provider: "fixture", model: "model-v1" };
  let runtime = [{ kind: "task" as const, id: "task-1", label: "已登记任务", content: "已登记任务" },
    { kind: "cron" as const, id: "cron-1", label: "明日执行", content: "明日执行" }];
  const store = new CrystalStorage({ agentDir: root });
  await store.initialize();
  store.putCrystal({ id: "cry-1", origin: "seed", stage: "candidate", name: "主题", dormant: false,
    checklist: {}, notified: false, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" });
  store.close();
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", path: workspace, name: "项目" }],
    loadConfig: async () => config, runtimeEntries: async () => runtime });
  assert.equal((await service.search("fixture", "p1", "provider"))[0]?.uri, "biny://provider/fixture");
  assert.equal((await service.search("主题", "p1", "crystal"))[0]?.uri, "biny://crystal/cry-1");
  assert.equal((await service.search("已登记", "p1", "task"))[0]?.uri, "biny://task/task-1");
  assert.doesNotMatch(JSON.stringify(await service.resolve("biny://provider/fixture", "p1")), /SECRET_KEY_MUST_NOT_LEAK/u);
  runtime = [];
  await assert.rejects(service.resolve("biny://task/task-1", "p1"));
  assert.throws(() => parseLocalReferenceUri("biny://mail/x"));
  console.log("local reference existing kind tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
