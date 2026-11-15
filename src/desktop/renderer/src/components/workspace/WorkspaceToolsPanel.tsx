import React from "react";
import { formatDuration } from "../../chatModel.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { toolCallTree } from "../../toolCallTree.js";
import { skillActivityLabels, type SkillActivity } from "../../skillActivity.js";
import { ToolExecutionStatus } from "../chat/ToolExecutionStatus.js";

export const WorkspaceToolsPanel = React.memo(function WorkspaceToolsPanel({ tools, skills = [] }: { tools: TimelineTool[]; skills?: readonly SkillActivity[] }): React.JSX.Element {
  const calls = React.useMemo(() => {
    const newest = toolCallTree(tools).reverse();
    const active = (tool: TimelineTool): boolean => tool.status === "running" || tool.status === "waiting";
    return [...newest.filter(active), ...newest.filter(tool => !active(tool))];
  }, [tools]);
  return <section className="inspector-utility-panel inspector-tools-panel">
    <header className="inspector-utility-heading"><h2>工具运行</h2><p>技能加载与工具调用的状态、错误与耗时。</p></header>
    <div className="inspector-result-scroll">
      {skills.length ? <section className="inspector-skill-activity" aria-label="技能状态"><h3>技能</h3>{skills.map(skill => <div key={skill.name} data-skill-name={skill.name}><p className="skill-activity-row"><span>{skill.name}</span><small>{skillActivityLabels[skill.status]}</small></p>{skill.error ? <p className="tool-run-error">{skill.error}</p> : null}</div>)}</section> : null}
      {!calls.length ? <p className="inspector-muted">还没有工具调用</p>
      : <ol className="tool-run-list" aria-label="工具运行记录">{calls.map(tool => <ToolRun key={tool.id} tool={tool} />)}</ol>}
    </div>
  </section>;
});

const ToolRun = React.memo(function ToolRun({ tool }: { tool: TimelineTool }): React.JSX.Element {
  const input = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args);
  return <li className="tool-run-card" data-tool-call-id={tool.id}>
    <ToolRunContent id={tool.id} tool={tool.tool} status={tool.status} timestamp={tool.timestamp} durationMs={tool.durationMs} error={tool.error} input={input} />
    {tool.children?.length ? <ol className="tool-run-children" aria-label="内部工具调用">{tool.children.map(child => <ToolRun key={child.id} tool={child} />)}</ol> : null}
  </li>;
});

// Snapshot only display primitives: tool objects and nested args may be mutated in place.
// Keep input serialization and child reconciliation outside this memo boundary.
const ToolRunContent = React.memo(function ToolRunContent({ id, tool, status, timestamp: rawTimestamp, durationMs, error, input }: Pick<TimelineTool, "id" | "tool" | "status" | "durationMs" | "error"> & { timestamp?: string; input?: string }): React.JSX.Element {
  const timestamp = rawTimestamp && Number.isFinite(Date.parse(rawTimestamp)) ? rawTimestamp : undefined;
  return <>
    <div className="tool-run-heading">
      <div className="tool-run-identity">
        <div className="tool-run-name" title={tool}>{tool}</div>
        <div className="tool-run-id" title={id}>{id}</div>
      </div>
      <ToolExecutionStatus status={status} />
    </div>
    {timestamp !== undefined || durationMs !== undefined ? <div className="tool-run-meta">
      {timestamp !== undefined ? <span>Start: <time dateTime={timestamp}>{new Date(timestamp).toLocaleTimeString()}</time></span> : null}
      {durationMs !== undefined ? <span>Duration: {durationMs < 1000 ? `${durationMs}ms` : formatDuration(durationMs)}</span> : null}
    </div> : null}
    {input !== undefined ? <div className="tool-run-input">{input}</div> : null}
    {error ? <div className="tool-run-error" role="alert">{error}</div> : null}
  </>;
});
