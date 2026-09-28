/** 消息菜单中的工具、技能与记忆召回状态；浮层脱离菜单动画，指针穿越间隙时保留短暂关闭宽限。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { executionToolLabel } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

const memoryRecallDetails: Record<string, string> = {
  no_vector_index: "未执行：向量索引尚未建立。请在设置 → 记忆中配置嵌入模型并重建索引。",
  no_embedding_runtime: "未执行：当前嵌入模型不可用。请检查记忆设置中的模型与凭据。",
  model_mismatch: "未执行：索引与当前嵌入模型不匹配。请在记忆设置中重建索引。"
};

export function MessageContextMenu({ tools, skills, skillSelection, skillLabels, descriptions, memoryRecallDegraded }: {
  tools: readonly string[];
  skills: readonly string[];
  skillSelection?: "auto" | "all" | "none" | readonly string[];
  skillLabels?: ReadonlyMap<string, string>;
  descriptions?: ReadonlyMap<string, string>;
  memoryRecallDegraded?: string;
}): React.JSX.Element {
  // Skill 工具只是加载通道；用户看到的是它加载的 Skill，而不是该内部工具名。
  const toolNames = [...new Set(tools)].filter((name) => name.trim() && name !== "Skill" && name !== "skill_call");
  // 自动选中的 SKILL.md 已注入本轮 prompt；技能列按本轮选择展示，不要求额外发出 Skill 工具调用。
  const selectedSkills = skillSelection === "all" || skillSelection === "auto"
    ? [...new Set(skillLabels?.values() ?? [])]
    : Array.isArray(skillSelection)
      ? skillSelection.map((name) => skillNameForDisplay(name, skillLabels)).filter((name): name is string => name !== undefined)
      : [];
  const skillNames = [...new Set([...selectedSkills, ...skills]
    .map((name) => skillNameForDisplay(name, skillLabels))
    .filter((name): name is string => name !== undefined && name.trim().length > 0))];
  const id = useId();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepOpen = (): void => { clearTimeout(closeTimer.current); setOpen(true); };
  const closeSoon = (): void => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const button = anchor.current; const surface = panel.current;
    let active = true;
    const cleanup = autoUpdate(button, surface, () => {
      void computePosition(button, surface, { placement: "right-start", strategy: "fixed", middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
        if (active) { surface.style.left = `${x}px`; surface.style.top = `${y}px`; surface.style.visibility = "visible"; }
      });
    });
    return () => { active = false; cleanup(); };
  }, [open]);
  return <div onPointerEnter={keepOpen} onPointerLeave={closeSoon} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button className="message-menu-item" role="menuitem" aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined} ref={anchor} type="button" onFocus={keepOpen} onClick={keepOpen} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setOpen(true); } if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}><Icon name="sliders" size={14} /><span>上下文</span><small>{toolNames.length} 个工具 · {skillNames.length} 个技能</small></button>
    {open ? createPortal(<div id={id} onPointerEnter={keepOpen} onPointerLeave={closeSoon} className="message-context-submenu" ref={panel} role="region" aria-label="本轮上下文" style={{ visibility: "hidden" }}>
      <section><h4>{toolNames.length} 个工具</h4>{toolNames.map((name) => <p key={name}>{executionToolLabel(name)}</p>)}{!toolNames.length ? <p>未调用工具</p> : null}</section>
      <section><h4>{skillNames.length} 个技能</h4>{skillNames.map((name) => <p key={name} title={descriptions?.get(name)}>{name}</p>)}{!skillNames.length ? <p>本轮未加载技能</p> : null}</section>
      {memoryRecallDegraded ? <section><h4>记忆召回</h4><p>{memoryRecallDetails[memoryRecallDegraded] ?? `未执行：${memoryRecallDegraded}`}</p></section> : null}
    </div>, document.body) : null}
  </div>;
}

function skillNameForDisplay(name: string, labels?: ReadonlyMap<string, string>): string | undefined {
  const label = labels?.get(name);
  if (label) return label;
  if (/^[a-f\d]{32}$/iu.test(name)) return undefined;
  const readable = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  return readable.trim() || undefined;
}
