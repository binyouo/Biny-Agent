/** 回复顶部的上下文清单：只展示本轮真实记录下来的记忆与能力选择。 */
import React, { Fragment, memo, useEffect, useId, useRef, useState } from "react";
import type { AgentCapabilitySelection } from "../../../../../agent/capabilitySelection.js";
import { executionToolLabel } from "../../sessionTimeline.js";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "../composer/ComposerPopover.js";

export const SkillsIndicator = memo(function SkillsIndicator({ memoryInjectedSummaries, selection: _selection, skillNames, skills, tools }: {
  memoryInjectedSummaries?: string[];
  /** 保留旧调用面的兼容字段；预选结果不是实际使用记录。 */
  selection?: AgentCapabilitySelection;
  skillNames?: ReadonlyMap<string, string>;
  skills?: readonly string[];
  tools?: readonly string[];
}): React.JSX.Element | null {
  void _selection;
  const invokedTools = [...new Set(tools ?? [])];
  const invokedSkills = [...new Set(skills ?? [])];
  const items = [
    memoryInjectedSummaries?.length
      ? { kind: "memory", icon: "brain" as const, names: memoryInjectedSummaries, text: `${String(memoryInjectedSummaries.length)} 条记忆`, title: "检索到的记忆", memory: true }
      : undefined,
    invokedTools.length
      ? { kind: "tools", icon: "wrench" as const, names: invokedTools.map(executionToolLabel), text: `${String(invokedTools.length)} 个工具`, title: "本轮实际调用的工具", memory: false }
      : undefined,
    invokedSkills.length
      ? { kind: "skills", icon: "wand" as const, names: invokedSkills.map((name) => skillNames?.get(name) ?? name), text: `${String(invokedSkills.length)} 个技能`, title: "本轮实际调用的 Skill", memory: false }
      : undefined
  ].filter((item) => item !== undefined);
  if (items.length === 0) return null;
  return (
    <div className="chat-meta-indicator">
      {items.map((item, index) => (
        <Fragment key={item.kind}>
          {index > 0 ? <span aria-hidden="true" className="chat-meta-separator">·</span> : null}
          <ContextIndicator icon={item.icon} memory={item.memory} names={item.names} text={item.text} title={item.title} />
        </Fragment>
      ))}
    </div>
  );
});

/** 复用现有锚点浮层，越过消息裁剪边界；悬停、点击和键盘聚焦都能查看清单。 */
function ContextIndicator({ icon, memory, names, text, title }: { icon: IconName; memory: boolean; names: string[]; text: string; title: string }): React.JSX.Element {
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
            <ul className={`chat-meta-tooltip-list${memory ? " is-memory" : ""}`}>{names.map((name, index) => <li key={`${String(index)}-${name}`}>{name}</li>)}</ul>
          </div>
        </ComposerPopover>
      ) : null}
    </>
  );
}
