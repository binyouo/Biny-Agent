/** 回复顶部仅保留真实的记忆召回降级警告；工具和技能清单已移入消息菜单。 */
import React, { Fragment, memo, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "../composer/ComposerPopover.js";

export const SkillsIndicator = memo(function SkillsIndicator({ memoryRecallDegraded }: {
  /** 本轮自动记忆召回的降级原因；这不是后台上下文清单，而是需要用户知道的异常提示。 */
  memoryRecallDegraded?: string;
  /** 技能名 → 介绍；悬停清单优先展示完整介绍。 */
  skillDescriptions?: ReadonlyMap<string, string>;
  skills?: readonly string[];
  tools?: readonly string[];
}): React.JSX.Element | null {
  // 记忆注入本身是后台上下文，不在回复顶部伪装成用户操作；只有召回降级这种异常才提示。
  const items = memoryRecallDegraded ? [{ kind: "memory-degraded", icon: "brain-off" as const,
    names: [memoryRecallDegraded], text: "记忆召回降级", title: `本轮自动记忆召回未执行：${memoryRecallDegraded}` }] : [];
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
