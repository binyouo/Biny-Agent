/** 计划卡片只投影 Host 事实；本地状态限于折叠和用户操作中的禁用状态。 */
import React, { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { DesktopRuntimeMutation, DesktopPlanProjection } from "../../../../protocol.js";
import { presentPlan, type Plan, type PlanNode } from "./planPresentation.js";

export function PlanPanel({ sessionId, planning, busy, projection, onMutation, onError }: {
  sessionId: string; planning: boolean; busy: boolean; projection?: DesktopPlanProjection;
  onMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onError(error: unknown): void;
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false);
  const plans = projection?.sessionId === sessionId ? projection.plans.filter((plan) => plan.nodes.length > 0) : [];
  const plan = plans.findLast((plan) => ["draft", "running", "paused"].includes(plan.status)) ?? plans.at(-1);
  if (!plan) return null;
  const change = async (operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void> => {
    setPending(true);
    try { await onMutation(operation, { ...payload, sessionId }); } catch (error) { onError(error); } finally { setPending(false); }
  };
  return <section className="biny-plan-panel" aria-label="执行计划">
    <PlanCard key={plan.graphId} plan={plan} generating={busy || plan.nodes.some((node) => node.taskStatus === "running")} />
    {/* 用户确认和命令审批是本产品的执行边界，不把控制项混入任务状态行。 */}
    {plan.status === "draft" ? <div className="biny-plan-actions">
      <button type="button" disabled={busy || pending} onClick={() => { void change("plan.start", { graphId: plan.graphId, revision: plan.revision }); }}>确认并开始</button>
      {planning ? <button type="button" disabled={busy || pending} onClick={() => { void change("plan.mode", { planning: false }); }}>退出规划</button> : null}
    </div> : null}
    {plan.pendingApprovals.map((approval) => <details className="biny-plan-approval" key={approval.approvalId}>
      <summary>等待验收授权 · {approval.key}</summary>
      <p>{approval.reason}</p><pre>{approval.command}</pre><p>cwd: {approval.cwd}</p>
      <code>biny task approve {approval.taskRunId} --approval-id {approval.approvalId}</code>
    </details>)}
  </section>;
}

function PlanCard({ plan, generating }: { plan: Plan; generating: boolean }): React.JSX.Element {
  const view = presentPlan(plan);
  const [expansion, setExpansion] = useState({ allDone: view.allDone, expanded: !view.allDone });
  const expanded = expansion.allDone === view.allDone ? expansion.expanded : !view.allDone;
  if (expansion.allDone !== view.allDone) setExpansion({ allDone: view.allDone, expanded });
  const reducedMotion = useReducedMotion();
  const contentId = useId();
  const currentLabel = view.feedback ? `正在返工 ${view.feedback.key} 的评审反馈` : view.active?.title ?? view.active?.key;
  return <div className="biny-plan-card">
    <button type="button" className="biny-plan-heading" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpansion({ allDone: view.allDone, expanded: !expanded })}>
      <span className="biny-plan-heading-main"><PlanGlyph name="waypoints" />
        <span className={`biny-plan-title${!expanded && currentLabel ? " is-current" : ""}`}>{!expanded && currentLabel ? currentLabel : plan.objective ?? "执行计划"}</span>
        <span className="biny-plan-progress">({view.done}/{view.total})</span>
      </span>
      <PlanGlyph name="chevron" className={`biny-plan-chevron${expanded ? "" : " is-collapsed"}`} />
    </button>
    {view.feedback ? <div className="biny-plan-feedback" role="status"><PlanGlyph name="warning" size={14} /><span>评审 {view.feedback.key} 要求返工</span></div> : null}
    <AnimatePresence initial={false}>
      {expanded ? <motion.div id={contentId} className="biny-plan-reveal" key="content"
        initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.33, 1, 0.68, 1] }}>
        <div className="biny-plan-content">{view.tasks.map((task) => <div className="biny-plan-task" key={task.key}>
          <div className={`biny-plan-task-heading is-${task.status}`}>
            <span className={`biny-plan-task-dot is-${task.status}`} />
            <span className="biny-plan-task-title">{task.title}</span>
            {task.status === "pending" && task.dependencies.length > 0 ? <span className="biny-plan-deps">先做 {task.dependencies.join(", ")}</span> : null}
          </div>
          <div className="biny-plan-blocks">{task.blocks.map(({ node, status }) => {
            const exhausted = status === "blocked" && plan.replans.used >= plan.replans.max && node.block?.kind === "review";
            const label = node.block?.kind === "review" ? "独立评审" : node.block?.kind === "report" ? "只读分析" : "实施";
            const state = nodeStateLabel(node);
            const icon = exhausted ? "warning" : status === "done" ? "check" : status === "blocked" ? "ban" : status === "in_progress" && generating ? "loader" : "circle";
            const revised = node.block?.kind === "review" && node.replacesNodeId !== undefined;
            return <div className={`biny-plan-block is-${status}${exhausted ? " is-exhausted" : ""}`} key={node.nodeId} title={state} aria-label={`${task.title} · ${label}：${state}`}>
              <PlanGlyph name={icon} className={icon === "loader" ? "is-spinning" : undefined} />
              <span className="biny-plan-block-title">{node.title || label}</span>
              {node.block?.kind === "review" ? <span className="biny-plan-review" title="独立评审；计数为整个计划共用的调整额度"><PlanGlyph name="shield" size={12} />{revised ? `${plan.replans.used}/${plan.replans.max}` : null}</span> : null}
            </div>;
          })}</div>
        </div>)}</div>
      </motion.div> : null}
    </AnimatePresence>
  </div>;
}

function nodeStateLabel(node: PlanNode): string {
  if (node.approval || node.taskStatus === "needs_approval") return "等待验收授权";
  if (node.status === "completed") return node.completionBasis === "report" ? "报告已产出（未独立验证）" : "验收已通过";
  return ({ running: "执行中", pending: "等待依赖", ready: "待执行", blocked: "受阻", failed: "失败", cancelled: "已停止" })[node.status] ?? node.status;
}

/*!
 * 下方内联图标保留 Lucide 的许可声明，不为有限的图标新增运行时依赖。
 * ISC License
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
function PlanGlyph({ name, size = 16, className }: { name: "waypoints" | "check" | "ban" | "loader" | "circle" | "chevron" | "warning" | "shield"; size?: number; className?: string }): React.JSX.Element {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    {name === "waypoints" ? <><circle cx="12" cy="4.5" r="2.5" /><path d="m10.2 6.3-3.9 3.9M7 12h10m-3.2 5.7 3.9-3.9" /><circle cx="4.5" cy="12" r="2.5" /><circle cx="19.5" cy="12" r="2.5" /><circle cx="12" cy="19.5" r="2.5" /></> : null}
    {name === "circle" || name === "check" || name === "ban" ? <circle cx="12" cy="12" r="10" /> : null}
    {name === "check" ? <path d="m9 12 2 2 4-4" /> : null}
    {name === "ban" ? <path d="m4.9 4.9 14.2 14.2" /> : null}
    {name === "loader" ? <path d="M21 12a9 9 0 1 1-6.219-8.56" /> : null}
    {name === "chevron" ? <path d="m18 15-6-6-6 6" /> : null}
    {name === "warning" ? <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01" /> : null}
    {name === "shield" ? <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></> : null}
  </svg>;
}
