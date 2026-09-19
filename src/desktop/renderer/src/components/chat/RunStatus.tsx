/**
 * 回合进行中的思考球状态行：球是「空档指示器」，不是常驻加载条。
 *
 * 有可见进行物（工具执行、思考/正文增量、待授权）时让位隐藏、保留高度，实时反馈由
 * 活动相位头、授权卡和流式光标承担；只在阶段间隙亮起补位：
 * 准备流水线按阶段换球换文案（TypingIndicator），回合建立后首个事件前 Sketching，
 * 步骤空档 Following the thread。文案为签名短语（英文）。
 */
import React, { memo } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { TimelineTurn } from "../../sessionTimeline.js";

/** 准备阶段的球形态与文案（choosingTools→connecting 等形态映射）。 */
const PREPARATION_PRESENTATION: Record<Exclude<NonNullable<TimelineTurn["preparationStage"]>, "ready">, { label: string; orb: OrbState }> = {
  memory: { label: "Searching memory...", orb: "searching" },
  skills: { label: "Choosing skills...", orb: "shaping" },
  tools: { label: "Choosing tools...", orb: "connecting" },
  workspace: { label: "Preparing workspace...", orb: "searching" },
  compacting: { label: "Compacting context...", orb: "weaving" },
  waiting: { label: "Thinking...", orb: "solving" }
};

export const RunStatus = memo(function RunStatus({ turn }: { turn?: TimelineTurn }): React.JSX.Element {
  const stage = turn?.preparationStage !== undefined && turn.preparationStage !== "ready"
    ? PREPARATION_PRESENTATION[turn.preparationStage]
    : undefined;
  const waiting = turn?.status === "waiting_permission" || turn?.tools.some((tool) => tool.permission && !tool.permission.resolved);
  const activeTool = turn?.tools.findLast((tool) => tool.status === "running" || tool.status === "waiting");
  const lastStep = turn?.steps.at(-1);
  const inFlight = Boolean(activeTool
    || (lastStep?.kind === "reasoning" && !lastStep.completed && lastStep.content.trim())
    || (lastStep?.kind === "assistant" && !lastStep.completed && lastStep.content.trim()));
  const suppressed = stage === undefined && (waiting || inFlight);
  let label: string;
  let orb: OrbState = "working";
  // Sketching / Following 用完整 20px 球与加重文案；准备与等首增量用 16px 行内球。
  let following = false;
  if (stage) {
    label = stage.label;
    orb = stage.orb;
  } else if (!turn || turn.steps.length === 0) {
    label = turn ? "Sketching things out" : "Thinking...";
    orb = turn ? "working" : "solving";
    following = Boolean(turn);
  } else if (lastStep?.kind === "reasoning" && !lastStep.completed && !lastStep.content.trim()) {
    // 思考已开始但首个增量未到：活动头此时只有「思考中」，这里补 Thinking 而非占位等待文案。
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
