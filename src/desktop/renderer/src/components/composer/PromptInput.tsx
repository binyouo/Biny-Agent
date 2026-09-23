/** 原生多行输入与命令补全；提交、附件持久化和任务调度由外层 Composer 负责。 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { DesktopSkillCatalogEntry } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { buildDesktopComposerItems } from "./desktopSlashCommands.js";
import { findPromptCompletion, filterPromptCompletions, replacePromptCompletion, promptKeyAction } from "./promptCompletion.js";
import { promptSkillDeletion, promptSkillTokens } from "./promptDecorations.js";
import { useBreathingCaret } from "./useBreathingCaret.js";

export function PromptInput({ value, onChange, onSubmit, onFiles, disabled, placeholder, skills, inputRef }: {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  onFiles(files: File[]): void;
  disabled: boolean;
  placeholder: string;
  skills: readonly DesktopSkillCatalogEntry[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
}): React.JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const skillOverlayRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const selectionFrame = useRef<number | undefined>(undefined);
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const items = useMemo(() => buildDesktopComposerItems(skills), [skills]);
  const tokens = useMemo(() => promptSkillTokens(value, skills), [value, skills]);
  const completion = findPromptCompletion(value, selection.start, selection.end);
  const completionKey = completion ? `${String(completion.start)}:${String(completion.end)}:${completion.query}` : undefined;
  const options = completion ? filterPromptCompletions(items, completion.query) : [];
  const open = focused && !disabled && completion !== undefined && completionKey !== dismissed;
  const selected = Math.min(activeIndex, Math.max(0, options.length - 1));
  useBreathingCaret(inputRef, surfaceRef, caretRef, trailRef, value, disabled);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // 先解除旧高度才能在删字、发送或编辑回填后同步收缩。
    input.style.height = "auto";
    input.style.height = `${String(Math.min(176, Math.max(64, input.scrollHeight)))}px`;
    const overlay = skillOverlayRef.current;
    if (overlay) { overlay.scrollTop = input.scrollTop; overlay.style.width = `${String(input.clientWidth)}px`; }
  }, [inputRef, value]);

  useEffect(() => {
    const input = inputRef.current;
    const anchor = anchorRef.current;
    if (!input || !anchor) return;
    let width = anchor.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === anchor.clientWidth) return;
      width = anchor.clientWidth;
      input.style.height = "auto";
      input.style.height = `${String(Math.min(176, Math.max(64, input.scrollHeight)))}px`;
      const overlay = skillOverlayRef.current;
      if (overlay) { overlay.scrollTop = input.scrollTop; overlay.style.width = `${String(input.clientWidth)}px`; }
    });
    observer.observe(anchor);
    return () => {
      observer.disconnect();
      if (selectionFrame.current !== undefined) cancelAnimationFrame(selectionFrame.current);
    };
  }, [inputRef]);

  const choose = (index: number): void => {
    const item = options[index];
    if (!completion || !item) return;
    const next = replacePromptCompletion(value, completion, item);
    onChange(next.value);
    setDismissed(completionKey);
    setActiveIndex(0);
    selectionFrame.current = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
      setSelection({ start: next.cursor, end: next.cursor });
    });
  };

  return <div className="biny-prompt-editor" ref={anchorRef}>
    <div className="biny-prompt-surface" ref={surfaceRef}>
    <div className="biny-prompt-skill-overlay" aria-hidden="true" ref={skillOverlayRef}>
      {tokens.map((token, index) => <React.Fragment key={token.start}>
        {value.slice(tokens[index - 1]?.end ?? 0, token.start)}
        <span className="biny-prompt-skill-token" data-skill-name={token.name}>{value.slice(token.start, token.end)}</span>
      </React.Fragment>)}
      {value.slice(tokens.at(-1)?.end ?? 0)}{"\u200b"}
    </div>
    <textarea
      ref={inputRef}
      className="biny-prompt-textarea"
      aria-label="任务输入"
      aria-autocomplete="list"
      aria-controls={open ? menuId : undefined}
      aria-activedescendant={open && options.length ? `${menuId}-${String(selected)}` : undefined}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      rows={2}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onScroll={(event) => {
        const overlay = skillOverlayRef.current;
        if (overlay) { overlay.scrollTop = event.currentTarget.scrollTop; overlay.scrollLeft = event.currentTarget.scrollLeft; }
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onChange={(event) => {
        onChange(event.currentTarget.value);
        setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
        setActiveIndex(0);
        setDismissed(undefined);
      }}
      onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
      onPaste={(event) => {
        const files = [...event.clipboardData.files];
        if (!files.length) return;
        event.preventDefault();
        onFiles(files);
      }}
      onKeyDown={(event) => {
        if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229
          && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const input = event.currentTarget;
          const deletion = promptSkillDeletion(value, input.selectionStart, input.selectionEnd, event.key, tokens);
          if (deletion) {
            event.preventDefault();
            input.setSelectionRange(deletion.start, deletion.end);
            // 优先让浏览器执行编辑以保留原生撤销栈，不改动发送给 Runtime 的技能协议。
            if (!document.execCommand("delete")) {
              onChange(value.slice(0, deletion.start) + value.slice(deletion.end));
              selectionFrame.current = requestAnimationFrame(() => {
                input.setSelectionRange(deletion.start, deletion.start);
                setSelection({ start: deletion.start, end: deletion.start });
              });
            }
            return;
          }
        }
        const action = promptKeyAction(event.nativeEvent, composing.current, open, options.length);
        if (action === "native") return;
        event.preventDefault();
        if (action === "dismiss") {
          event.stopPropagation(); setDismissed(completionKey);
        } else if (action === "next" || action === "previous") {
          setActiveIndex((selected + (action === "next" ? 1 : -1) + options.length) % options.length);
        } else if (action === "choose") {
          choose(selected);
        } else {
          onSubmit();
        }
      }}
    />
    <div className="biny-breathing-caret-trails" ref={trailRef} aria-hidden="true" />
    <div className="biny-breathing-caret" ref={caretRef} aria-hidden="true" />
    </div>
    {open ? <ComposerPopover anchorRef={anchorRef} className="composer-popover biny-prompt-completions" phase="open">
      <div id={menuId} role="listbox" aria-label="命令和技能">
        {options.length ? options.map((item, index) => <button
          key={item.id} id={`${menuId}-${String(index)}`} type="button" role="option" tabIndex={-1}
          aria-selected={index === selected}
          ref={index === selected ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(index)}>
          <span className={`desktop-slash-option is-${item.auxiliaryData.kind}`}>
            <span className="desktop-slash-option-icon"><Icon name={item.auxiliaryData.icon} size={14} /></span>
            <span className="desktop-slash-option-copy"><span className="desktop-slash-option-name"><code>{item.label}</code>{item.auxiliaryData.hint ? <em className="desktop-slash-option-hint">{item.auxiliaryData.hint}</em> : null}</span><span className="desktop-slash-option-desc">{item.auxiliaryData.description}</span></span>
          </span>
        </button>) : <p className="biny-prompt-completions-empty">没有匹配的命令或技能</p>}
      </div>
    </ComposerPopover> : null}
  </div>;
}
