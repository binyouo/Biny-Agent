/**
 * 活动段：连续「思考 + 工具」步骤的可展开记录。
 *
 * 头部是相位头像串（思考/探索/修改/运行/通用五类，24px 圆形图标，重叠堆叠）+ 摘要文案 +
 * 展开控件；落定后默认收起，摘要报「工具调用 N 次」或纯思考的「已思考 N 秒」；
 * 当前阶段直接反馈运行状态，消息末尾只在等待空档补充提示。
 *
 * 运行时只展开最新相位；结束后可点头像查看单相位，或打开完整时间线。
 * 工具行是动宾紧凑行（读取 xx / 编辑 xx +3 -2），点击行内展开完整工具详情；
 * 思考相位直接平铺思考文本。待授权卡片独立展示在工具详情之后。
 *
 * 待授权优先展示其所在相位；整个活动段结束后收起，不在工具间空档重置。
 */
import React, { memo, useMemo, useState } from "react";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import {
  activityToolRow,
  buildActivityPhases,
  phaseLabel,
  phaseThinkingSeconds,
  type ActivityPhase,
  type ActivityPhaseItem,
  type ActivityPhaseKind,
} from "../../chatModel.js";
import type { IconName } from "../Icon.js";
import { reasoningDetailText } from "../../reasoningPresentation.js";
import type { TimelineReasoningStep, TimelineTool, TimelineToolStep } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { ToolActivityDetail, ToolPermission } from "../ToolActivity.js";
import { Collapse } from "../Collapse.js";

/** 可进活动段的步骤：工具调用或思考相位。 */
export type ActivitySegmentStep = TimelineToolStep | TimelineReasoningStep;

const PHASE_ICONS: Record<ActivityPhaseKind, IconName> = {
  thinking: "brain",
  exploring: "search",
  making: "edit",
  running: "terminal",
  generic: "wrench",
};

/** 头像串最多直显的相位数，超出的折叠成「+N」。 */
const MAX_VISIBLE_PHASES = 8;

interface ActivitySegmentProps {
  /** 连续的思考 + 工具步骤（单个也走活动段，呈现为一枚头像 + 一行摘要）。 */
  steps: ActivitySegmentStep[];
  /** 当前活动段是否仍在执行；同轮较早的段按历史记录展示。 */
  running: boolean;
  /** 轮次级思考耗时（秒）；段内思考相位缺失时长时的兜底。 */
  thinkingSeconds?: number;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}

export const ActivitySegment = memo(function ActivitySegment({
  steps,
  running,
  thinkingSeconds,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: ActivitySegmentProps): React.JSX.Element | null {
  const items: ActivityPhaseItem[] = useMemo(
    () => steps.map((step, index) => ({ step, index })),
    [steps]
  );
  const phases = useMemo(() => buildActivityPhases(items), [items]);
  const segmentKey = steps[0]?.id ?? "activity";
  const isLive = (phase: ActivityPhase): boolean => running && phase.items.some(({ step }) =>
    step.kind === "reasoning" ? !step.completed : step.kind === "tool" && (step.tool.status === "running" || step.tool.status === "waiting")
  );
  const labelFor = (phase: ActivityPhase, seconds?: number) => {
    if (running && phase.items.some(({ step }) => step.kind === "tool" && step.tool.permission && !step.tool.permission.resolved)) {
      return { verb: "等待确认", rest: "" };
    }
    if (isLive(phase) && phase.kind === "thinking" && !phase.items.some(({ step }) => step.kind === "reasoning" && step.content.trim())) {
      return { verb: "等待模型响应", rest: "" };
    }
    return phaseLabel(phase, isLive(phase), seconds);
  };
  const activePhase = phases.findLast(isLive);
  const toolSteps = useMemo(
    () => steps.filter((step): step is Extract<ActivitySegmentStep, { kind: "tool" }> => step.kind === "tool"),
    [steps]
  );
  const allThinking = phases.length > 0 && phases.every((phase) => phase.kind === "thinking");
  const thinkingPhaseCount = phases.filter((phase) => phase.kind === "thinking").length;
  const secondsForThinkingPhase = (phase: ActivityPhase): number | undefined =>
    phaseThinkingSeconds(phase) ?? (thinkingPhaseCount === 1 ? thinkingSeconds : undefined);

  // 待授权时自动进入所在相位；授权独立于工具详情的折叠状态。
  const forcedToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of toolSteps.map((step) => step.tool)) {
      if (tool.permission && !tool.permission.resolved) ids.add(tool.id);
    }
    return ids;
  }, [toolSteps]);
  const pendingPhaseIndex = forcedToolIds.size > 0
    ? phases.findIndex((phase) => phase.items.some(({ step }) => step.kind === "tool" && step.tool.permission && !step.tool.permission.resolved))
    : -1;

  // 模型执行时自动跟随，只有落定后的选择才由用户控制。恢复执行也清除旧选择。
  const [selection, setSelection] = useState<{ running: boolean; phase: number | null; timeline: boolean }>({ running, phase: null, timeline: false });
  if (selection.running !== running) setSelection({ running, phase: null, timeline: false });
  const timelineMode = !running && selection.running === running && selection.timeline;
  const selectedPhase = pendingPhaseIndex >= 0 ? pendingPhaseIndex
    : running ? phases.length - 1 : selection.running === running ? selection.phase : null;
  const railOpen = timelineMode || selectedPhase !== null;
  const close = (): void => setSelection({ running, phase: null, timeline: false });
  const openTimeline = (): void => setSelection({ running, phase: null, timeline: true });
  const openPhase = (index: number): void => setSelection({ running, phase: selectedPhase === index ? null : index, timeline: false });

  if (phases.length === 0) return null;

  const openPhaseOrNull = selectedPhase !== null && selectedPhase >= 0 ? phases[selectedPhase] : null;
  const hiddenCount = Math.max(0, phases.length - MAX_VISIBLE_PHASES);

  // 执行中的标题不可切换；最新相位已经自动展开。
  const pureThinkingSeconds = allThinking ? secondsForThinkingPhase(phases[0]!) : undefined;
  const headerLabel = openPhaseOrNull && !timelineMode
    ? labelFor(openPhaseOrNull, secondsForThinkingPhase(openPhaseOrNull))
    : activePhase ? labelFor(activePhase) : null;

  return (
    <section className={`chat-activity${railOpen ? " is-open" : ""}`} data-activity-anchor="" data-running={running || undefined}>
      <div className="chat-activity-header">
        <div className="chat-activity-avatars">
          {hiddenCount > 0 ? (
            <button
              aria-label={`${String(hiddenCount)} 个更早阶段`}
              className="chat-phase-avatar is-overflow"
              data-activity-toggle=""
              disabled={running}
              onClick={openTimeline}
              title={`${String(hiddenCount)} 个更早阶段`}
              type="button"
            >+{String(hiddenCount)}</button>
          ) : null}
          {phases.slice(hiddenCount).map((phase, visibleIndex) => {
            const index = hiddenCount + visibleIndex;
            const isOpen = selectedPhase === index;
            // 执行中的最新相位头像带呼吸光环（alma activity-avatar-alive），空档一眼可辨。
            const isAlive = running && index === phases.length - 1 && isLive(phase);
            return (
              <button
                aria-label={labelFor(phase).verb}
                data-activity-toggle=""
                disabled={running}
                className={`chat-phase-avatar${isOpen ? " is-active" : ""}${isAlive ? " is-alive" : ""}`}
                key={`${segmentKey}-avatar-${String(index)}`}
                onClick={() => openPhase(index)}
                style={phases.length > 1 ? { marginLeft: visibleIndex === 0 && hiddenCount === 0 ? 0 : -7, zIndex: isOpen || isAlive ? 50 : visibleIndex + 1 } : undefined}
                type="button"
              >
                <Icon name={PHASE_ICONS[phase.kind]} size={12} />
              </button>
            );
          })}
        </div>
        {running ? (
          <span className={`chat-activity-label${activePhase && forcedToolIds.size === 0 ? " chat-shimmer-text" : ""}`} role="status">
            {headerLabel?.verb}{headerLabel?.rest ? ` ${headerLabel.rest}` : ""}
          </span>
        ) : (
          <>
            <button aria-expanded={railOpen} className="chat-activity-summary" data-activity-toggle="" onClick={() => railOpen ? close() : openTimeline()} type="button">
              {allThinking ? (
                <>
                  <span className="chat-activity-verb">已思考</span>
                  {pureThinkingSeconds !== undefined ? <span className="chat-activity-rest"> {String(pureThinkingSeconds)} 秒</span> : null}
                </>
              ) : headerLabel ? (
                <>
                  <span className="chat-activity-verb">{headerLabel.verb}</span>
                  {headerLabel.rest ? <span className="chat-activity-rest"> {headerLabel.rest}</span> : null}
                </>
              ) : <span className="chat-activity-verb">工具调用 {String(toolSteps.length)} 次</span>}
            </button>
            {!allThinking && phases.length > 1 ? (
              <button
                aria-label="时间线视图"
                aria-expanded={timelineMode}
                aria-pressed={timelineMode}
                className={`chat-activity-mode${timelineMode ? " is-active" : ""}`}
                data-activity-toggle=""
                onClick={() => timelineMode ? setSelection({ running, phase: phases.length - 1, timeline: false }) : openTimeline()}
                title="时间线视图"
                type="button"
              ><Icon name="list-tree" size={14} /></button>
            ) : null}
            <button
              aria-expanded={railOpen}
              aria-label={railOpen ? "收起活动" : "展开活动"}
              className="chat-activity-chevron"
              data-activity-toggle=""
              onClick={() => railOpen ? close() : openTimeline()}
              type="button"
            ><Icon name="chevron" size={14} /></button>
          </>
        )}
      </div>
      <Collapse className="chat-activity-collapse" open={railOpen}>
        <div className="chat-activity-rail">
          {timelineMode || !openPhaseOrNull
            ? phases.map((phase, index) => {
              const thinkingSecondsForPhase = secondsForThinkingPhase(phase);
              const label = labelFor(phase, thinkingSecondsForPhase);
              return (
                <div className="chat-activity-phase" key={`${segmentKey}-phase-${String(index)}`}>
                  {phase.kind === "thinking" ? (
                    <div className="chat-activity-phase-label">
                      <span className="chat-activity-verb">{label.verb}</span>
                      {label.rest ? <span className="chat-activity-rest"> {label.rest}</span> : null}
                    </div>
                  ) : null}
                  <PhaseBody
                    onOpenExternal={onOpenExternal}
                    onPreviewFile={onPreviewFile}
                    onResolvePermission={onResolvePermission}
                    phase={phase}
                    projectId={projectId}
                    segmentKey={segmentKey}
                  />
                </div>
              );
            })
            : (
              <PhaseBody
                key={openPhaseOrNull?.items[0]?.step.id}
                onOpenExternal={onOpenExternal}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                phase={openPhaseOrNull}
                projectId={projectId}
                segmentKey={segmentKey}
              />
            )}
        </div>
      </Collapse>
    </section>
  );
});

/** 一个相位的展开体：思考相位平铺文本；工具相位渲染动宾行 + 行内详情。 */
const PhaseBody = memo(function PhaseBody({
  phase,
  segmentKey,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  phase: ActivityPhase;
  segmentKey: string;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element | null {
  if (phase.kind === "thinking") {
    const text = phase.items
      .map(({ step }) => step.kind === "reasoning" ? reasoningDetailText(step) : "")
      .filter(Boolean)
      .join("\n\n");
    if (!text) return null;
    return <div className="chat-activity-thinking">{text}</div>;
  }
  return (
    <>
      {phase.items.map(({ step }) => {
        if (step.kind !== "tool") return null;
        return (
          <ActivityToolRow
            key={`${segmentKey}-row-${step.id}`}
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            onResolvePermission={onResolvePermission}
            projectId={projectId}
            tool={step.tool}
          />
        );
      })}
    </>
  );
});

/** 轨道里的工具动宾行：动词加重、宾语弱化截断、± 行数、行内展开完整详情。 */
export const ActivityToolRow = memo(function ActivityToolRow({
  tool,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  tool: TimelineTool;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const row = activityToolRow(tool);
  const [open, setOpen] = useState(["Bash", "Write", "Edit"].includes(tool.tool));
  const running = row.running;
  return (
    <div data-activity-anchor="" className={`chat-tool-row-wrap${tool.permission ? " has-permission" : ""}`}>
      <button
        aria-expanded={open}
        className={`chat-tool-row${open ? " is-open" : ""}`}
        data-activity-toggle=""
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {running ? <span aria-hidden="true" className="chat-tool-run-dot" /> : null}
        {row.error ? <span aria-hidden="true" className="chat-tool-row-error"><Icon name="circle-close" size={12} /></span> : null}
        <span className={`chat-tool-row-verb${row.error ? " is-error" : ""}`}>{row.verb}</span>
        <span className="chat-tool-row-object" title={row.object}>{row.object}</span>
        {row.plus !== undefined && row.plus > 0 ? <span className="chat-tool-row-diff is-add">+{String(row.plus)}</span> : null}
        {row.minus !== undefined && row.minus > 0 ? <span className="chat-tool-row-diff is-del">-{String(row.minus)}</span> : null}
        <span className="chat-tool-row-chevron"><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse className="chat-tool-row-collapse" open={open}>
        <div className="chat-tool-row-detail">
          <ToolActivityDetail
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            projectId={projectId}
            tool={tool}
          />
        </div>
      </Collapse>
      <ToolPermission tool={tool} onResolvePermission={onResolvePermission} />
    </div>
  );
});
