import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdentityStorage } from "../src/agent/context/identityStorage.js";
import {
  detectIdentitySecretWarning,
  identityDocumentFileNames,
  renderIdentityPrompt
} from "../src/agent/context/identityFormat.js";
import { identityDocumentKinds } from "../src/agent/context/identityTypes.js";
import { buildSystemPrompt } from "../src/agent/prompts.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-identity-test-"));
  const agent = path.join(root, "biny-agent");

  try {
    // Soul 属于应用内置人格；用户身份存储只保留 USER.md。
    assert.deepEqual([...identityDocumentKinds], ["user"]);
    assert.deepEqual(identityDocumentFileNames, { user: "USER.md" });

    const storage = new IdentityStorage({ configDir: agent });
    // 初始化前不创建任何目录，overview 返回空快照。
    assert.equal((await storage.overview()).revision, 0);
    await assert.rejects(fs.access(agent), /ENOENT/u);
    await storage.initialize();

    // 写入 user 文档，revision 递增。
    const savedUser = await storage.saveDocument("user", "# User\n\nPrefer small verified changes.\n", 0);
    assert.equal(savedUser.revision, 1);
    assert.equal(savedUser.documents.user?.content, "# User\n\nPrefer small verified changes.");
    assert.equal(await fs.readFile(path.join(agent, "USER.md"), "utf8"), "# User\n\nPrefer small verified changes.\n");

    // revision 乐观锁：过期 expectedRevision 触发冲突。
    await assert.rejects(
      storage.saveDocument("user", "# User\n\nA stale edit.\n", 0),
      /revision conflict/iu
    );

    // prompt 投影：includeUser=true 时注入 user，关闭时不注入。
    const withUser = renderIdentityPrompt({ documents: savedUser.documents, includeUser: true });
    assert.ok(withUser);
    assert.match(withUser, /USER PROFILE \(the person you are working with/u);
    assert.match(withUser, /long-term goals/u);
    assert.match(withUser, /Prefer small verified changes/u);
    assert.equal(renderIdentityPrompt({ documents: savedUser.documents, includeUser: false }), undefined);

    // 空文档集合不产生 prompt。
    assert.equal(renderIdentityPrompt({ documents: {}, includeUser: true }), undefined);

    // 未注入用户 Soul 时，系统提示直接使用固定默认人格，不生成内置 Soul 区块。
    const systemPrompt = buildSystemPrompt({ cwd: "/workspace" });
    assert.match(systemPrompt, /You are Biny\./u);
    assert.match(systemPrompt, /LANGUAGE RULE \(CRITICAL\)/u);
    assert.match(systemPrompt, /Do not describe yourself as a generic assistant/u);
    assert.match(systemPrompt, /Never fabricate file contents/u);
    assert.doesNotMatch(systemPrompt, /<biny_soul source="builtin">/u);

    // 密钥警示保留：能识别疑似凭据，但不修改正文。
    assert.equal(detectIdentitySecretWarning("apiKey=sk-identity-secret-value"), "检测到疑似凭据字段。");
    assert.equal(detectIdentitySecretWarning("token ghp_abcdefghijklmnopqrstuvwxyz123"), "检测到疑似访问凭据。");
    assert.equal(detectIdentitySecretWarning("Just a normal preference."), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("identity tests passed");
}

void main();
