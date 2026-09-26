/** 原生多行输入与命令补全；提交、附件持久化和任务调度由外层 Composer 负责。 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { DesktopSkillCatalogEntry } from "../../../../protocol.js";
import type { LocalReferenceKind, LocalReferenceResult } from "../../../../../session/localReferences.js";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { buildDesktopComposerItems } from "./desktopSlashCommands.js";
import { findPromptCompletion, filterPromptCompletions, replacePromptCompletion, promptKeyAction } from "./promptCompletion.js";
import { promptSkillDeletion, promptSkillTokens } from "./promptDecorations.js";
import { useBreathingCaret } from "./useBreathingCaret.js";
import { findReferenceCompletion, insertDraftReference, normalizeDraftReferences, reconcileDraftReferenceChange,
  referenceDraftDeletion, referenceKeyAction, referenceKindLabel, referenceResultSubtitle, type DraftReferenceToken } from "./referenceCompletion.js";

const referenceIcons: Record<LocalReferenceKind, IconName> = {
  date: "calendar", project: "folder", file: "file", thread: "message", message: "message", memory: "brain",
  snippet: "file-text", scratch: "file-text", skill: "wand", agent: "person", mcp: "plug", model: "cpu",
  provider: "server", tool: "wrench", "tool-call": "wrench", task: "check", cron: "timer",
  crystal: "cube", bundle: "cube", mission: "circle-check", plan: "list-tree"
};

export function PromptInput({ value, onChange, onReferenceChange, onInspectReference, referenceTokens, onSubmit, onFiles, disabled, placeholder, skills, projectId, inputRef }: {
  value: string;
  onChange(value: string, inputType?: string): void;
  onReferenceChange(value: string, tokens: DraftReferenceToken[]): void;
  onInspectReference?(reference: LocalReferenceResult): void;
  referenceTokens: readonly DraftReferenceToken[];
  onSubmit(): void;
  onFiles(files: File[]): void;
  disabled: boolean;
  placeholder: string;
  skills: readonly DesktopSkillCatalogEntry[];
  projectId?: string;
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
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [referenceResults, setReferenceResults] = useState<LocalReferenceResult[]>([]);
  const [referenceError, setReferenceError] = useState<string>();
  const [referenceDismissed, setReferenceDismissed] = useState<string>();
  const [compositionRevision, setCompositionRevision] = useState(0);
  const menuId = useId();
  const items = useMemo(() => buildDesktopComposerItems(skills), [skills]);
  const tokens = useMemo(() => promptSkillTokens(value, skills), [value, skills]);
  const decorations = [...tokens.map((token) => ({ ...token, type: "skill" as const })),
    ...referenceTokens.filter((token) => value.slice(token.start, token.end) === `@${token.label}`)
      .map((token) => ({ ...token, type: "ref" as const }))].sort((left, right) => left.start - right.start);
  const completion = findPromptCompletion(value, selection.start, selection.end);
  const referenceCompletion = findReferenceCompletion(value, selection.start, selection.end, referenceTokens);
  const referenceKey = referenceCompletion ? `${referenceCompletion.start}:${referenceCompletion.end}:${referenceCompletion.query}` : undefined;
  const referenceQuery = referenceCompletion?.query;
  const referenceKind = referenceCompletion?.kind;
  const unknownReferencePrefix = referenceCompletion?.unknownPrefix;
  const referenceOpen = focused && !disabled && projectId !== undefined && referenceCompletion !== undefined && referenceKey !== referenceDismissed;
  const completionKey = completion ? `${String(completion.start)}:${String(completion.end)}:${completion.query}` : undefined;
  const options = completion ? filterPromptCompletions(items, completion.query) : [];
  const open = focused && !disabled && completion !== undefined && completionKey !== dismissed;
  const selected = Math.min(activeIndex, Math.max(0, options.length - 1));
  const selectedReference = Math.min(referenceIndex, Math.max(0, referenceResults.length - 1));
  useBreathingCaret(inputRef, surfaceRef, caretRef, trailRef, value, disabled);

  useEffect(() => {
    if (!referenceOpen || referenceQuery === undefined || !projectId) { setReferenceResults([]); setReferenceError(undefined); return; }
    if (unknownReferencePrefix) { setReferenceResults([]); setReferenceError(`未知引用种类：${unknownReferencePrefix}`); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void window.biny.referenceSearch(projectId, referenceQuery, referenceKind,
        Intl.DateTimeFormat().resolvedOptions().timeZone).then((results) => {
        if (active) { setReferenceResults(results); setReferenceError(undefined); setReferenceIndex(0); }
      }).catch((cause) => { if (active) { setReferenceResults([]); setReferenceError(cause instanceof Error ? cause.message : String(cause)); } });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [referenceOpen, referenceKey, referenceQuery, referenceKind, unknownReferencePrefix, projectId, compositionRevision]);

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

  const chooseReference = (index: number): void => {
    const result = referenceResults[index];
    if (!referenceCompletion || !result) return;
    const next = insertDraftReference(value, referenceCompletion, result, referenceTokens);
    onReferenceChange(next.value, next.tokens);
    onInspectReference?.(result);
    setReferenceDismissed(referenceKey);
    setReferenceIndex(0);
    selectionFrame.current = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
      setSelection({ start: next.cursor, end: next.cursor });
    });
  };

  return <div className="biny-prompt-editor" ref={anchorRef}>
    <div className="biny-prompt-surface" ref={surfaceRef}>
    {decorations.length > 0 ? <div className="biny-prompt-skill-overlay" aria-hidden="true" ref={skillOverlayRef}>
      {decorations.map((token, index) => <React.Fragment key={`${token.type}-${String(token.start)}`}>
        {value.slice(decorations[index - 1]?.end ?? 0, token.start)}
        {token.type === "skill"
          ? <span className="biny-prompt-skill-token" data-skill-name={token.name}>{value.slice(token.start, token.end)}</span>
          : <span className="biny-prompt-reference-token" data-reference-kind={token.kind}>
            <span className="biny-prompt-reference-icon"><span>@</span><Icon name={referenceIcons[token.kind]} size={11} /></span>
            {value.slice(token.start + 1, token.end)}
          </span>}
      </React.Fragment>)}
      {value.slice(decorations.at(-1)?.end ?? 0)}{"\u200b"}
    </div> : null}
    <textarea
      ref={inputRef}
      className={`biny-prompt-textarea${decorations.length ? " has-decorations" : ""}`}
      aria-label="任务输入"
      aria-autocomplete="list"
      aria-controls={open || referenceOpen ? menuId : undefined}
      aria-activedescendant={open && options.length ? `${menuId}-${String(selected)}` : referenceOpen && referenceResults.length ? `${menuId}-ref-${String(selectedReference)}` : undefined}
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
      onCompositionEnd={() => { composing.current = false; setCompositionRevision((value) => value + 1); }}
      onChange={(event) => {
        onChange(event.currentTarget.value, (event.nativeEvent as InputEvent).inputType);
        setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
        setActiveIndex(0);
        setDismissed(undefined);
        setReferenceDismissed(undefined);
      }}
      onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
      onPaste={(event) => {
        const files = [...event.clipboardData.files];
        if (files.length) { event.preventDefault(); onFiles(files); return; }
        const text = event.clipboardData.getData("text/plain");
        if (!/@\[[^\]\n]{1,80}\]\(biny:\/\//u.test(text)) return;
        event.preventDefault();
        const input = event.currentTarget;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const raw = value.slice(0, start) + text + value.slice(end);
        const retained = reconcileDraftReferenceChange(value, raw, referenceTokens);
        const next = normalizeDraftReferences(raw, retained);
        onReferenceChange(next.value, next.tokens);
        const cursor = next.value.length - value.slice(end).length;
        selectionFrame.current = requestAnimationFrame(() => {
          input.setSelectionRange(cursor, cursor);
          setSelection({ start: cursor, end: cursor });
        });
      }}
      onKeyDown={(event) => {
        const referenceAction = referenceKeyAction(event.nativeEvent, composing.current, referenceOpen, referenceResults.length);
        if (referenceAction !== "native") {
          event.preventDefault();
          if (referenceAction === "dismiss") { event.stopPropagation(); setReferenceDismissed(referenceKey); }
          else if (referenceAction === "next" || referenceAction === "previous") {
            setReferenceIndex((selectedReference + (referenceAction === "next" ? 1 : -1) + referenceResults.length) % referenceResults.length);
          } else chooseReference(selectedReference);
          return;
        }
        if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229
          && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const input = event.currentTarget;
          const deletion = referenceDraftDeletion(value, input.selectionStart, input.selectionEnd, event.key, referenceTokens)
            ?? promptSkillDeletion(value, input.selectionStart, input.selectionEnd, event.key, tokens);
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
    {referenceOpen ? <ComposerPopover anchorRef={anchorRef} className="composer-popover biny-prompt-completions" phase="open">
      <div id={menuId} role="listbox" aria-label="本地引用">
        {referenceError ? <p className="biny-prompt-completions-empty" role="alert">{referenceError}</p> : null}
        {!referenceError && !referenceResults.length ? <p className="biny-prompt-completions-empty">没有匹配的引用</p> : null}
        {referenceResults.map((result, index) => <React.Fragment key={result.uri}>
          {index === 0 || referenceResults[index - 1]?.kind !== result.kind ? <p className="biny-prompt-completions-kind" role="presentation">{referenceKindLabel(result.kind)}</p> : null}
          <button id={`${menuId}-ref-${String(index)}`} type="button" role="option"
          aria-selected={index === selectedReference} tabIndex={-1} onMouseDown={(event) => event.preventDefault()}
          ref={index === selectedReference ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
          onClick={() => chooseReference(index)}>
          <span className="desktop-slash-option"><span className="desktop-slash-option-copy">
            <span className="desktop-slash-option-name"><code>{result.label}</code></span>
            <span className="desktop-slash-option-desc">{referenceResultSubtitle(result)}</span>
          </span></span>
        </button></React.Fragment>)}
      </div>
    </ComposerPopover> : null}
  </div>;
}
