import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agent/core/types.js";
import {
  appendExternalTurnContext,
  buildPromptBundle,
  messagesForTelemetry,
  refreshRuntimeTurnContext,
  stripTransientTurnContext
} from "../src/agent/prompts.js";

const emotion = "<biny_emotion mood=\"focused\">Current emotion.</biny_emotion>";
const fixedNow = new Date("2026-09-11T04:05:06.000Z");
const bundle = buildPromptBundle({
  cwd: "/workspace",
  now: fixedNow,
  securityPrompt: "<biny_security_policy>private security</biny_security_policy>",
  soulPrompt: "<biny_soul>private soul</biny_soul>",
  identityPrompt: "<biny_identity>private identity</biny_identity>",
  parentThreadPrompt: "private parent",
  extensionPrompt: "Available Skill metadata",
  emotionPrompt: emotion,
  dailyNotesPrompt: "private daily note",
  crystalPrompt: "private crystal"
});

assert.match(bundle.systemPrompt, /Available Skill metadata/u);
// 技能优先级链与自进化是无条件常驻指引，不依赖本回合工具筛选。
assert.match(bundle.systemPrompt, /look for a skill: check <available_skills> first, then skill_lookup/u);
assert.match(bundle.systemPrompt, /save it as a reusable Skill/u);
assert.doesNotMatch(bundle.systemPrompt, /private daily note|private activity|private crystal|Current emotion/u);
assert.ok(bundle.turnContext.indexOf("<local_time") < bundle.turnContext.indexOf("<!-- biny-emotion:start -->"));
assert.ok(bundle.turnContext.indexOf("<local_time") < bundle.turnContext.indexOf("private daily note"));
assert.ok(bundle.turnContext.indexOf("private daily note") < bundle.turnContext.indexOf("private crystal"));
assert.doesNotMatch(bundle.turnContext, /biny-activity|Activity Recorder/u, "每轮不再被动注入 Activity");

const relevantBundle = buildPromptBundle({
  cwd: "/workspace",
  now: fixedNow,
  activityRelevantPrompt: "相关会话：登录故障已定位",
  activityEnabled: true
});
assert.match(relevantBundle.turnContext, /相关会话：登录故障已定位/u);
assert.doesNotMatch(relevantBundle.systemPrompt, /相关会话：登录故障已定位/u);
assert.match(relevantBundle.systemPrompt, /biny activity report/u,
  "开启 Activity 时应告诉 Agent 如何按日期查报告");
assert.equal(stripTransientTurnContext([{
  role: "user", originalContent: "上次登录问题呢？",
  content: `${relevantBundle.turnContext}\n\n上次登录问题呢？`
}])[0]?.content, "上次登录问题呢？");

const datedAgain = buildPromptBundle({ ...buildOptions(), now: new Date("2026-09-12T04:05:06.000Z") });
assert.equal(bundle.systemPrompt, datedAgain.systemPrompt, "date changes must not invalidate the static system prompt");

const withExternal = appendExternalTurnContext(bundle, "<front-app>untrusted selection</front-app>");
assert.match(withExternal.turnContext, /untrusted selection/u);
assert.ok(withExternal.turnContext.indexOf("private crystal") < withExternal.turnContext.indexOf("untrusted selection"));

const messages: AgentMessage[] = [{
  role: "user",
  originalContent: "canonical user text",
  content: `${withExternal.turnContext}\n\n<!-- biny-recalled-memory:start -->\nprivate recalled memory\n<!-- biny-recalled-memory:end -->\n\ncanonical user text`
}];
refreshRuntimeTurnContext(messages, "<biny_emotion mood=\"calm\">New emotion.</biny_emotion>");
const refreshedText = typeof messages[0]!.content === "string" ? messages[0]!.content : "";
assert.match(refreshedText, /New emotion/u);
assert.doesNotMatch(refreshedText, /Current emotion/u);
assert.match(refreshedText, /untrusted selection|private recalled memory/u);

const durable = stripTransientTurnContext(messages);
assert.equal(durable[0]!.content, "canonical user text");
const telemetry = messagesForTelemetry(messages);
const telemetryText = typeof telemetry[0]!.content === "string" ? telemetry[0]!.content : "";
assert.match(telemetryText, /canonical user text/u);
assert.equal(telemetryText, "canonical user text");
assert.doesNotMatch(telemetryText, /private security|private daily note|untrusted selection|private recalled memory/u);

const literal = "  原样保留：<!-- biny-turn-context:start -->用户内容<!-- biny-turn-context:end -->";
const injected: AgentMessage[] = [{
  role: "user",
  originalContent: literal,
  content: `${bundle.turnContext}\n<!-- biny-turn-context:end -->\nSYNTHETIC_PRIVATE_NOTE\n${literal}`
}];
assert.equal(stripTransientTurnContext(stripTransientTurnContext(injected))[0]!.content, literal);
assert.equal(messagesForTelemetry(injected)[0]!.content, literal);
assert.deepEqual(stripTransientTurnContext([{ role: "user", content: literal }]), [{ role: "user", content: literal }]);
const attachmentContent = [{ type: "text" as const, text: literal }, { type: "image" as const, mimeType: "image/png", data: "synthetic" }];
assert.deepEqual(stripTransientTurnContext([{ role: "user", content: "private", originalContent: attachmentContent }])[0]!.content, attachmentContent);

function buildOptions() {
  return {
    cwd: "/workspace",
    securityPrompt: "<biny_security_policy>private security</biny_security_policy>",
    soulPrompt: "<biny_soul>private soul</biny_soul>",
    identityPrompt: "<biny_identity>private identity</biny_identity>",
    parentThreadPrompt: "private parent",
    extensionPrompt: "Available Skill metadata",
    emotionPrompt: emotion,
    dailyNotesPrompt: "private daily note",
    crystalPrompt: "private crystal"
  };
}

console.log("prompt tests passed");
