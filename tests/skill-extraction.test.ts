/** 回合后技能提取管线：阈值跳过、两步辅助模型、校验落盘与进度通知。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { runSkillExtraction, type SkillExtractionNotice } from "../src/agent/skillExtraction.js";
import type { SessionEvent } from "../src/session/recorder.js";

const skillMarkdown = [
  "---",
  "name: deploy-staging",
  "description: Deploy the current workspace to the staging environment.",
  "allowed-tools:",
  "  - Bash",
  "  - Read",
  "---",
  "",
  "# Deploy to staging",
  "",
  "1. Run the checks.",
  "2. Deploy and verify."
].join("\n");

/** 按调用顺序回放回答：第一次 analyst JSON，第二次 author SKILL.md。 */
function replayModel(answers: string[]): { model: AgentModel; calls: string[] } {
  const calls: string[] = [];
  const model: AgentModel = {
    provider: "test", modelId: "extraction",
    stream: async (context) => {
      const answer = answers[calls.length] ?? "";
      calls.push(context.systemPrompt ?? "");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: answer };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  return { model, calls };
}

function turnEvents(toolCallCount: number): SessionEvent[] {
  const events: SessionEvent[] = [{ type: "user_message", messageId: "m1", content: "把当前工作区部署到预发环境" }];
  for (let index = 0; index < toolCallCount; index += 1) {
    events.push({ type: "tool_call", tool: index % 2 === 0 ? "Bash" : "Read", args: { command: `step-${String(index)}` }, toolCallId: `call-${String(index)}` });
    events.push({ type: "tool_result", tool: index % 2 === 0 ? "Bash" : "Read", result: { output: `done-${String(index)}` }, toolCallId: `call-${String(index)}` });
  }
  events.push({ type: "assistant_message", content: "部署完成并已验证。" });
  return events;
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-extraction-"));
  try {
    // 阈值未达：不调模型、不落盘、不通知。
    const below = replayModel([]);
    const belowOutcome = await runSkillExtraction({
      messageId: "m1", events: turnEvents(3), installedSkills: [], model: below.model, minToolCalls: 5, homeDir: root
    });
    assert.equal(below.calls.length, 0);
    assert.equal(belowOutcome.installedPath, undefined);

    // analyst 判定不值得：只调一次模型，不落盘。
    const rejected = replayModel([JSON.stringify({ worthy: false, skillName: "", skillDescription: "", reasoning: "one-off fix" })]);
    const rejectedOutcome = await runSkillExtraction({
      messageId: "m1", events: turnEvents(6), installedSkills: [], model: rejected.model, minToolCalls: 5, homeDir: root
    });
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejectedOutcome.installedPath, undefined);

    // 成功链路：analyst worthy → author 生成 → 原子落盘 + 通知阶段 + 强制刷新。
    const notices: SkillExtractionNotice[] = [];
    let refreshed = 0;
    const accepted = replayModel([
      JSON.stringify({ worthy: true, skillName: "deploy-staging", skillDescription: "Deploy the workspace to staging.", reasoning: "reusable", existingSkillToUpdate: null }),
      skillMarkdown
    ]);
    const outcome = await runSkillExtraction({
      messageId: "m1", events: turnEvents(6),
      installedSkills: [{ name: "daily-report", description: "日报" }],
      model: accepted.model, minToolCalls: 5, homeDir: root,
      onNotice: (notice) => notices.push(notice),
      refreshSkills: async () => { refreshed += 1; }
    });
    assert.equal(accepted.calls.length, 2, "analyst 与 author 各一次辅助模型调用");
    assert.ok(outcome.installedPath);
    assert.deepEqual(
      { ...outcome, installedPath: undefined },
      { stage: "done", skillName: "deploy-staging", skillDescription: "Deploy the current workspace to the staging environment.", updated: false, installedPath: undefined },
      "新技能落盘到受管根，description 以 author 产出为准"
    );
    assert.equal(path.dirname(outcome.installedPath!), path.join(root, ".config", "biny", "skills", "deploy-staging"));
    const saved = await readFile(outcome.installedPath!, "utf8");
    assert.match(saved, /^---\nname: deploy-staging\n/u);
    assert.equal(refreshed, 1, "保存后必须强制刷新技能目录");
    assert.deepEqual(notices.map((notice) => notice.stage), ["extracting", "saving", "done"], "进度通知只覆盖真实提取，不含 analyst 阶段");
    // analyst 提示词带已有技能清单，供重叠判断。
    assert.match(accepted.calls[0]!, /daily-report/u);

    // 同名技能已存在：覆盖写入并标记 updated。
    const updateNotices: SkillExtractionNotice[] = [];
    const update = replayModel([
      JSON.stringify({ worthy: true, skillName: "deploy-staging", skillDescription: "Updated staging deploy.", reasoning: "improved", existingSkillToUpdate: "deploy-staging" }),
      skillMarkdown.replace("Deploy the current workspace", "Deploy the workspace")
    ]);
    const updatedOutcome = await runSkillExtraction({
      messageId: "m1", events: turnEvents(6), installedSkills: [{ name: "deploy-staging", description: "old" }],
      model: update.model, minToolCalls: 5, homeDir: root,
      onNotice: (notice) => updateNotices.push(notice)
    });
    assert.equal(updatedOutcome.updated, true);
    assert.equal(updateNotices.at(-1)?.updated, true);
    assert.match(await readFile(updatedOutcome.installedPath!, "utf8"), /Deploy the workspace/u);

    // author 生成的 name 非法：拒绝落盘。
    const invalid = replayModel([
      JSON.stringify({ worthy: true, skillName: "Deploy Staging", skillDescription: "x", reasoning: "r", existingSkillToUpdate: null }),
      skillMarkdown.replace("name: deploy-staging", "name: Deploy_Staging")
    ]);
    await assert.rejects(runSkillExtraction({
      messageId: "m1", events: turnEvents(6), installedSkills: [], model: invalid.model, minToolCalls: 5, homeDir: root
    }), /无效|name/u);

    // 输出含敏感内容时经 redactSecrets 进入素材（间接由 summarizeValue 保证）；缺辅助模型直接跳过。
    const noModel = await runSkillExtraction({ messageId: "m1", events: turnEvents(9), installedSkills: [], minToolCalls: 5, homeDir: root });
    assert.equal(noModel.installedPath, undefined);
    console.log("skill extraction tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
