import { useEffect, useRef, useState } from "react";

const CACHE_MS = 5 * 60_000;
let cached: { at: number; suggestions: string[] } | undefined;
let inFlight: Promise<string[]> | undefined;

function loadSuggestions(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.suggestions);
  if (!inFlight) {
    inFlight = window.biny.activitySuggestions().then(suggestions => {
      cached = { at: Date.now(), suggestions };
      return suggestions;
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
  if (suggestions?.length === 0) return null;
  return <div aria-label="根据近期活动建议的新对话" aria-busy={suggestions === undefined || submitting} className="biny-activity-suggestions">
    {suggestions === undefined ? [0, 1, 2, 3].map(index => <div aria-hidden="true" key={index} className="biny-activity-suggestion-skeleton" style={{ animationDelay: `${220 + index * 70}ms` }}><div className="biny-activity-suggestion-placeholder" /></div>)
      : suggestions.map((text, index) => <button className="suggestion-chip" disabled={submitting} key={`${index}:${text}`} onClick={() => void send(text)} style={{ animationDelay: `${220 + index * 70}ms` }} title={text} type="button">{text}</button>)}
  </div>;
}
