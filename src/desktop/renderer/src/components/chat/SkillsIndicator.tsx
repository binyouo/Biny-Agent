/** 回复顶部的上下文清单：展示本轮真实调用的技能（含介绍悬停）与工具。 */
import React, { Fragment, memo, useEffect, useId, useRef, useState } from "react";
import { executionToolLabel } from "../../sessionTimeline.js";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "../composer/ComposerPopover.js";

/** 回合顶部的技能启用清单：auto 预选或手动勾选的技能在正文开始前就可见。 */
export const TurnSkillsNotice = memo(function TurnSkillsNotice({ names }: { names: readonly string[] }): React.JSX.Element | null {
  if (!names.length) return null;
  return (
    <div className="chat-turn-skills">
      <span className="chat-turn-skills-label"><Icon name="wand" size={11} />本回合技能</span>
      <ul className="chat-turn-skills-list">{names.map((name) => <li key={name}>{name}</li>)}</ul>
    </div>
  );
});

export const SkillsIndicator = memo(function SkillsIndicator({ memoryRecallDegraded, skillDescriptions, skills, tools }: {
  /** 本轮自动记忆召回的降级原因；这不是后台上下文清单，而是需要用户知道的异常提示。 */
  memoryRecallDegraded?: string;
  /** 技能名 → 介绍；悬停清单优先展示完整介绍。 */
  skillDescriptions?: ReadonlyMap<string, string>;
  skills?: readonly string[];
  tools?: readonly string[];
}): React.JSX.Element | null {
  // 记忆注入本身是后台上下文，不在回复顶部伪装成用户操作；只有召回降级这种异常才提示。
  const invokedSkills = [...new Set(skills ?? [])].filter((name) => name.trim());
  const invokedTools = [...new Set(tools ?? [])].filter(isVisibleResponseTool);
  const items = [
    memoryRecallDegraded
      ? {
        kind: "memory-degraded" as const,
        icon: "brain-off" as const,
        names: [memoryRecallDegraded],
        text: "记忆召回降级",
        title: `本轮自动记忆召回未执行：${memoryRecallDegraded}`
      }
      : undefined,
    invokedSkills.length
      ? {
        kind: "skills" as const,
        icon: "wand" as const,
        names: invokedSkills.map((name) => {
          const description = skillDescriptions?.get(name);
          return description ? `${name} — ${description}` : name;
        }),
        text: `${String(invokedSkills.length)} 个技能`,
        title: "本轮调用的技能"
      }
      : undefined,
    invokedTools.length
      ? {
        kind: "tools" as const,
        icon: "wrench" as const,
        names: invokedTools.map(executionToolLabel),
        text: `${String(invokedTools.length)} 个工具`,
        title: "本轮实际调用的工具"
      }
      : undefined
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (items.length === 0) return null;
  return (
    <div className="chat-meta-indicator">
      {items.map((item, index) => (
        <Fragment key={item.kind}>
          {index > 0 ? <span aria-hidden="true" className="chat-meta-separator">·</span> : null}
          <ContextIndicator icon={item.icon} names={item.names} text={item.text} title={item.title} />
        </Fragment>
      ))}
    </div>
  );
});

/** 复用现有锚点浮层，越过消息裁剪边界；悬停、点击和键盘聚焦都能查看清单。 */
function ContextIndicator({ icon, names, text, title }: { icon: IconName; names: string[]; text: string; title: string }): React.JSX.Element {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const keepOpen = (): void => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = (): void => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  return (
    <>
      <button aria-describedby={open ? id : undefined} aria-expanded={open} className="chat-meta-trigger" onBlur={closeSoon} onClick={keepOpen} onFocus={keepOpen} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} onPointerEnter={keepOpen} onPointerLeave={closeSoon} ref={anchorRef} type="button">
        <Icon name={icon} size={11} /><span>{text}</span>
      </button>
      {open ? (
        <ComposerPopover anchorRef={anchorRef} className="chat-meta-tooltip" onPointerEnter={keepOpen} onPointerLeave={closeSoon} phase="open">
          <div id={id} role="tooltip">
            <div className="chat-meta-tooltip-title">{title}</div>
            <ul className="chat-meta-tooltip-list">{names.map((name, index) => <li key={`${String(index)}-${name}`}>{name}</li>)}</ul>
          </div>
        </ComposerPopover>
      ) : null}
    </>
  );
}

/** 探索、分页、状态同步和记忆/技能内部动作不占用用户可见的工具摘要。 */
const VISIBLE_RESPONSE_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch", "Task"]);

function isVisibleResponseTool(tool: string): boolean {
  return VISIBLE_RESPONSE_TOOLS.has(tool);
}
