import { useChatResponseSettings } from "../../chatResponseSettings.js";
/**
 * 活动段：连续「思考 + 工具」步骤的可展开记录。
 *
 * 头部是相位头像串（思考/探索/修改/运行/通用五类，24px 圆形图标，重叠堆叠）+ 摘要文案 +
 * 展开控件；落定后默认收起，摘要报「工具调用 N 次」或纯思考的「已思考 N 秒」；
 * 当前阶段直接反馈运行状态，消息末尾只在等待空档补充提示。
 *
 * 头部只渲染最近 8 个相位，较早阶段以「+N」计数表示；点击计数打开完整时间线。
 *
 * 运行时只展开最新相位；结束后可点头像查看单相位，或打开完整时间线。
 * 工具行是动宾紧凑行（读取 xx / 编辑 xx +3 -2），点击行内展开完整工具详情；
 * 思考相位直接平铺思考文本。待授权卡片独立展示在工具详情之后。
 *
 * 待授权优先展示其所在相位；整个活动段结束后收起，不在工具间空档重置。
 */
import React, { memo, useCallback, useId, useMemo, useRef, useState } from "react";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import {
  activityToolRow,
  buildActivityPhases,
  formatDuration,
  phaseLabel,
  phaseThinkingSeconds,
  type ActivityPhase,
  type ActivityPhaseItem,
  type ActivityPhaseKind,
  type ActivityPhaseLabel,
} from "../../chatModel.js";
import type { IconName } from "../Icon.js";
import { reasoningDetailText, reasoningExpandable, reasoningSummaryLine } from "../../reasoningPresentation.js";
import type { TimelineReasoningStep, TimelineTool, TimelineToolStep } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { ToolActivityDetail, ToolPermission } from "../ToolActivity.js";
import { Collapse } from "../Collapse.js";
import { ToolResultImages } from "./ToolResultImages.js";
import { WidgetRenderer } from "../WidgetRenderer.js";

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
  onResolvePermission?(requestId: string, result: PermissionResult): Promise<void>;
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
  const { collapseThinking } = useChatResponseSettings();
  const items: ActivityPhaseItem[] = useMemo(
    () => steps.map((step, index) => ({ step, index })),
    [steps]
  );
  const phases = useMemo(() => buildActivityPhases(items), [items]);
  const segmentKey = steps[0]?.id ?? "activity";
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTool = useCallback((id: string) => setOpenTools(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const isLive = (phase: ActivityPhase): boolean => running && phase.items.some(({ step }) =>
    step.kind === "reasoning" ? !step.completed : step.kind === "tool" && (step.tool.status === "running" || step.tool.status === "waiting")
  );
  const labelFor = (phase: ActivityPhase, seconds?: number) => {
    if (running && phase.items.some(({ step }) => step.kind === "tool" && step.tool.permission && !step.tool.permission.resolved)) {
      return { verb: "等待确认", rest: "" };
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
  const thinkingIndex = phases.findLastIndex((phase) => phase.kind === "thinking");
  const defaultPhase = !collapseThinking && thinkingIndex >= 0 ? thinkingIndex : null;
  const [selection, setSelection] = useState<{ running: boolean; collapsed: boolean; phase: number | null; timeline: boolean }>({ running, collapsed: collapseThinking, phase: defaultPhase, timeline: !collapseThinking && allThinking });
  if (selection.running !== running || selection.collapsed !== collapseThinking) setSelection({ running, collapsed: collapseThinking, phase: defaultPhase, timeline: !collapseThinking && allThinking });
  // 活动期间始终呈现完整轨道，让较早的思考和工具步骤留在当前进度旁边；
  // 落定后再恢复按偏好收起的单相位/时间线选择。
  const timelineMode = running || (selection.running === running && selection.timeline);
  const selectedPhase = pendingPhaseIndex >= 0 ? pendingPhaseIndex
    : running ? phases.length - 1 : selection.running === running ? selection.phase : null;
  const railOpen = timelineMode || selectedPhase !== null;
  const close = (): void => setSelection({ running, collapsed: collapseThinking, phase: null, timeline: false });
  const openTimeline = (): void => setSelection({ running, collapsed: collapseThinking, phase: null, timeline: true });
  const openPhase = (index: number): void => setSelection({ running, collapsed: collapseThinking, phase: selectedPhase === index ? null : index, timeline: false });

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
        <div className={`chat-activity-avatars${phases.length > 1 ? " is-stacked" : ""}`}>
          {hiddenCount > 0 ? (
            <button
              aria-label={`${String(hiddenCount)} 个更早阶段`}
              className="chat-phase-avatar is-overflow"
              data-activity-toggle=""
              disabled={running}
              key={`${segmentKey}-avatar-overflow`}
              onClick={openTimeline}
              title={`${String(hiddenCount)} 个更早阶段（含思考与工具），点击查看时间线`}
              type="button"
            >+{String(hiddenCount)}</button>
          ) : null}
          {phases.slice(hiddenCount).map((phase, visibleIndex) => {
            const index = hiddenCount + visibleIndex;
            const isOpen = selectedPhase === index;
            // 执行中的最新相位头像带呼吸光环，空档一眼可辨。
            const isAlive = running && index === phases.length - 1 && isLive(phase);
            return (
              <button
                aria-label={labelFor(phase).verb}
                data-activity-toggle=""
                disabled={running}
                className={`chat-phase-avatar${isOpen ? " is-active" : ""}${isAlive ? " is-alive" : ""}`}
                key={`${segmentKey}-avatar-${String(index)}`}
                onClick={() => openPhase(index)}
                style={phases.length > 1 ? { marginLeft: visibleIndex === 0 ? (hiddenCount > 0 ? 6 : 0) : -7, zIndex: isOpen || isAlive ? 50 : visibleIndex + 1 } : undefined}
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
                onClick={() => timelineMode ? setSelection({ running, collapsed: collapseThinking, phase: phases.length - 1, timeline: false }) : openTimeline()}
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
              const label = labelFor(phase, secondsForThinkingPhase(phase));
              return (
                <div className="chat-activity-phase" key={`${segmentKey}-phase-${String(index)}`}>
                  <PhaseBody
                    compact={{ label, live: isLive(phase) }}
                    onOpenExternal={onOpenExternal}
                    onPreviewFile={onPreviewFile}
                    onResolvePermission={onResolvePermission}
                    phase={phase}
                    openTools={openTools}
                    onToggleTool={toggleTool}
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
                openTools={openTools}
                onToggleTool={toggleTool}
                projectId={projectId}
                segmentKey={segmentKey}
              />
            )}
        </div>
      </Collapse>
      {toolSteps.map(({ tool }) => <ToolResultImages key={tool.id} result={tool.result} />)}
      {toolSteps.filter(({ tool }) => tool.tool === "WidgetRenderer").map(({ tool }) => <WidgetRenderer key={`widget-${tool.id}`} tool={tool} running={running} onOpenExternal={onOpenExternal} />)}
    </section>
  );
});

/**
 * 一个相位的展开体。时间线视图里的思考相位收成一行 chip（可展开全文）；
 * 单相位视图里的思考相位直接显示全文；工具相位渲染动宾行 + 行内详情。
 */
const PhaseBody = memo(function PhaseBody({
  phase,
  compact,
  openTools,
  onToggleTool,
  segmentKey,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  phase: ActivityPhase;
  compact?: { label: ActivityPhaseLabel; live: boolean };
  openTools: ReadonlySet<string>;
  onToggleTool(id: string): void;
  segmentKey: string;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission?(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element | null {
  if (phase.kind === "thinking") {
    const text = phase.items
      .map(({ step }) => step.kind === "reasoning" ? reasoningDetailText(step) : "")
      .filter(Boolean)
      .join("\n\n");
    if (compact) {
      return (
        <ThinkingChip
          label={compact.label}
          live={compact.live}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          projectId={projectId}
          text={text}
        />
      );
    }
    if (!text) return null;
    return (
      <div className="chat-activity-thinking">
        <MarkdownContent
          content={text}
          onOpenExternal={onOpenExternal}
          onPreviewFile={onPreviewFile}
          projectId={projectId}
          variant="is-thinking"
        />
      </div>
    );
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
            open={openTools.has(step.tool.id)}
            onToggle={() => onToggleTool(step.tool.id)}
          />
        );
      })}
    </>
  );
});

/**
 * 思考相位的一行 chip：标签、耗时和一行摘要。已落定且内容超过一行时可点击，在原位展开全文；
 * 运行中只显示最新一行，不可展开。全文在展开后才渲染，长思考不占据活动段版面。
 */
const ThinkingChip = memo(function ThinkingChip({
  label,
  live,
  text,
  projectId,
  onPreviewFile,
  onOpenExternal,
}: {
  label: ActivityPhaseLabel;
  live: boolean;
  text: string;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = !live && reasoningExpandable(text);
  const head = (
    <>
      <span className={`chat-think-label${live ? " chat-shimmer-text" : ""}`}>{label.verb}</span>
      {label.rest ? <span className="chat-think-time">{label.rest}</span> : null}
      <span className="chat-think-summary">{reasoningSummaryLine(text, live ? "live" : "settled")}</span>
      {expandable ? <span aria-hidden="true" className="chat-think-chevron"><Icon name="chevron" size={12} /></span> : null}
    </>
  );
  if (!expandable) return <div className={`chat-think-chip${live ? " is-live" : ""}`}>{head}</div>;
  return (
    <div className={`chat-think${open ? " is-open" : ""}`}>
      <button className="chat-think-chip" aria-expanded={open} data-activity-toggle="" onClick={() => setOpen(current => !current)} type="button">{head}</button>
      {open ? (
        <div className="chat-activity-thinking">
          <MarkdownContent
            content={text}
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            projectId={projectId}
            variant="is-thinking"
          />
        </div>
      ) : null}
    </div>
  );
});

/** 轨道里的工具动宾行：动词加重、宾语弱化截断、± 行数、行内展开完整详情。 */
export const ActivityToolRow = memo(function ActivityToolRow({
  tool,
  open: controlledOpen,
  onToggle,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  tool: TimelineTool;
  open?: boolean;
  onToggle?(): void;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission?(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const row = activityToolRow(tool);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const toggle = (): void => { if (onToggle) onToggle(); else setLocalOpen(current => !current); };
  const detailId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const running = row.running;
  return (
    <div data-activity-anchor="" className={`chat-tool-row-wrap${tool.permission ? " has-permission" : ""}`} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.stopPropagation(); toggle(); buttonRef.current?.focus(); }
    }}>
      <button
        aria-expanded={open}
        aria-controls={detailId}
        ref={buttonRef}
        className={`chat-tool-row${open ? " is-open" : ""}`}
        data-activity-toggle=""
        onClick={toggle}
        type="button"
      >
        {running ? <span aria-hidden="true" className="chat-tool-run-dot" /> : null}
        {row.error ? <span aria-hidden="true" className="chat-tool-row-error"><Icon name="circle-close" size={12} /></span> : null}
        <span className={`chat-tool-row-verb${row.error ? " is-error" : ""}`}>{row.verb}</span>
        <span className="chat-tool-row-object" title={row.object}>{row.object}</span>
        {row.plus !== undefined && row.plus > 0 ? <span className="chat-tool-row-diff is-add">+{String(row.plus)}</span> : null}
        {row.minus !== undefined && row.minus > 0 ? <span className="chat-tool-row-diff is-del">-{String(row.minus)}</span> : null}
        {tool.durationMs !== undefined ? (
          <span className="chat-tool-row-duration" title="耗时"><Icon name="timer" size={12} />{formatDuration(tool.durationMs)}</span>
        ) : null}
        <span className="chat-tool-row-chevron"><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse className="chat-tool-row-collapse" open={open}>
        <div className="chat-tool-row-detail" id={detailId}>
          <ToolActivityDetail
            onOpenExternal={onOpenExternal}
            onPreviewFile={onPreviewFile}
            projectId={projectId}
            tool={tool}
          />
        </div>
      </Collapse>
      {onResolvePermission ? <ToolPermission tool={tool} onResolvePermission={onResolvePermission} /> : null}
    </div>
  );
});
