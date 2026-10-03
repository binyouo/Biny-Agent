/** 空档显示思考球；正文、活动或授权卡接管时隐藏并保留高度，避免聊天布局跳动。 */
import React, { memo } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { TimelineTurn } from "../../sessionTimeline.js";

const PREPARATION_PRESENTATION: Partial<Record<NonNullable<TimelineTurn["preparationStage"]>, { label: string; orb: OrbState }>> = {
  memory: { label: "正在检索记忆", orb: "searching" },
  skills: { label: "正在分析 Skill", orb: "shaping" },
  tools: { label: "正在分析工具", orb: "connecting" },
  compacting: { label: "正在压缩上下文", orb: "weaving" }
};

export const RunStatus = memo(function RunStatus({ turn }: { turn?: TimelineTurn }): React.JSX.Element {
  const preparation = turn?.preparationStage === undefined ? undefined : PREPARATION_PRESENTATION[turn.preparationStage];
  const waiting = turn?.status === "waiting_permission" || turn?.tools.some((tool) => tool.permission && !tool.permission.resolved);
  const activeTool = turn?.tools.findLast((tool) => tool.status === "running" || tool.status === "waiting");
  const lastStep = turn?.steps.at(-1);
  const inFlight = Boolean(activeTool
    || (lastStep?.kind === "reasoning" && !lastStep.completed && lastStep.content.trim())
    || (lastStep?.kind === "assistant" && !lastStep.completed && lastStep.content.trim()));
  const suppressed = Boolean(waiting || inFlight);
  let label: string;
  let orb: OrbState = "working";
  let following = false;
  if (preparation) {
    label = preparation.label;
    orb = preparation.orb;
  } else if (!turn || turn.steps.length === 0
    || (lastStep?.kind === "reasoning" && !lastStep.completed && !lastStep.content.trim())) {
    label = "Thinking...";
    orb = "solving";
  } else {
    label = "Following the thread";
    orb = "working";
    following = true;
  }
  return (
    <div aria-hidden={suppressed || undefined} className={`chat-run-status${following ? " is-following" : ""}${suppressed ? " is-suppressed" : ""}`}>
      <div className={`chat-run-status-line${following ? " is-orb-appear" : ""}`}>
        <ThinkingOrb aria-hidden="true" className="chat-run-status-orb" paused={suppressed} size={20} state={orb} style={following ? undefined : { width: 16, height: 16 }} />
        <span className="chat-run-status-label chat-shimmer-text" role={suppressed ? undefined : "status"} title={label}>{label}</span>
      </div>
    </div>
  );
});
