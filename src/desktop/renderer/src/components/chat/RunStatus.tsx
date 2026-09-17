/** 准备及步骤间空档的反馈；已有实时阶段或正文时隐藏，保留高度避免跳动。 */
import React, { memo } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { activityToolRow } from "../../chatModel.js";
import type { TimelineTurn } from "../../sessionTimeline.js";

export const RunStatus = memo(function RunStatus({ turn }: { turn?: TimelineTurn }): React.JSX.Element {
  const waiting = turn?.status === "waiting_permission" || turn?.tools.some((tool) => tool.permission && !tool.permission.resolved);
  const activeTool = turn?.tools.findLast((tool) => tool.status === "running" || tool.status === "waiting");
  const lastStep = turn?.steps.at(-1);
  const preparing = turn?.preparationStage && turn.preparationStage !== "ready";
  const suppressed = !preparing && (waiting
    ? Boolean(turn?.tools.some((tool) => tool.permission && !tool.permission.resolved))
    : Boolean(activeTool
      || (lastStep?.kind === "reasoning" && !lastStep.completed && lastStep.content.trim())
      || (lastStep?.kind === "assistant" && !lastStep.completed && lastStep.content.trim())));
  let label = turn ? "正在继续处理…" : "正在准备…";
  let orb: OrbState = "working";
  if (waiting) label = "等待你的确认…";
  else if (turn?.preparationStage && turn.preparationStage !== "ready") {
    label = { capabilities: "正在分析相关工具和技能…", workspace: "正在读取工作区上下文…", memory: "正在检索相关记忆…", compacting: "正在压缩对话上下文…" }[turn.preparationStage];
    orb = ({ capabilities: "shaping", workspace: "searching", memory: "searching", compacting: "weaving" } as const)[turn.preparationStage];
  } else if (activeTool) {
    const row = activityToolRow(activeTool);
    label = `正在${row.verb} ${row.object}`;
  } else if (lastStep?.kind === "reasoning" && !lastStep.completed) {
    label = lastStep.content.trim() ? "正在思考…" : "正在等待模型响应…";
    orb = "solving";
  } else if (lastStep?.kind === "assistant" && !lastStep.completed) label = "正在生成回复…";
  else if (!lastStep) {
    label = "正在准备…";
    orb = "solving";
  }
  // 准备与思考保持行内小图形；工具及步骤间等待使用完整的 20px 轨道粒子。
  const following = orb === "working" && !waiting;
  return (
    <div aria-hidden={suppressed || undefined} className={`chat-run-status${waiting ? " is-waiting" : ""}${following ? " is-following" : ""}${suppressed ? " is-suppressed" : ""}`}>
      <ThinkingOrb aria-hidden="true" className="chat-run-status-orb" paused={Boolean(waiting) || suppressed} size={20} state={orb} style={following ? undefined : { width: 16, height: 16 }} />
      <span className={`chat-run-status-label${waiting || suppressed ? "" : " chat-shimmer-text"}`} role={suppressed ? undefined : "status"} title={label}>{label}</span>
    </div>
  );
});
