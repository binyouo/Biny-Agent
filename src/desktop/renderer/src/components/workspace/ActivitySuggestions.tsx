import { useEffect, useRef, useState } from "react";

const CACHE_MS = 5 * 60_000;
let cached: { at: number; suggestions: string[] } | undefined;
let inFlight: Promise<string[]> | undefined;

function loadSuggestions(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.suggestions);
  if (!inFlight) {
    inFlight = window.biny.activitySuggestions().then(suggestions => {
      // 空结果不等于建议被撤回：保留上一次非空结果，避免刷新后已展示的短语整块消失。
      const next = suggestions.length > 0 ? suggestions : (cached?.suggestions ?? []);
      cached = { at: Date.now(), suggestions: next };
      return next;
    }).finally(() => { inFlight = undefined; });
  }
  return inFlight;
}

export function ActivitySuggestions({ onSend, onError }: {
  onSend(text: string): Promise<void>;
  onError(error: unknown): void;
}): React.JSX.Element | null {
  const [suggestions, setSuggestions] = useState<string[] | undefined>(() => cached?.suggestions);
  const [submitting, setSubmitting] = useState(false);
  const submitFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void loadSuggestions().then(result => {
      if (active) setSuggestions(result);
    }, () => {
      if (active) setSuggestions(current => current ?? []);
    });
    return () => { active = false; };
  }, []);

  const send = async (text: string): Promise<void> => {
    if (submitFlight.current) return;
    submitFlight.current = true;
    setSubmitting(true);
    try { await onSend(text); }
    catch (error) { onError(error); }
    finally { submitFlight.current = false; setSubmitting(false); }
  };
  // 只在拿到真实短语后渲染：加载中不放占位，无结果或失败时保持不可见，不会出现后又消失的情况。
  if (!suggestions?.length) return null;
  return <div aria-label="根据近期活动建议的新对话" className="biny-activity-suggestions">
    {suggestions.map((text, index) => <button className="suggestion-chip" disabled={submitting} key={`${index}:${text}`} onClick={() => void send(text)} style={{ animationDelay: `${220 + index * 70}ms` }} title={text} type="button">{text}</button>)}
  </div>;
}
