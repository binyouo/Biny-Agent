import React from "react";
import { useHighlightedCode } from "../../useHighlightedCode.js";
import { CopyButton } from "../CopyButton.js";

export function ToolCodeBlock({ text, language = "text", label, copyLabel, dashed = false, error = false }: {
  text: string; language?: string; label: string; copyLabel: string; dashed?: boolean; error?: boolean;
}): React.JSX.Element {
  const highlighted = useHighlightedCode(text, language);
  return <div className={`tool-code-block${dashed ? " is-parameter" : ""}${error ? " is-error" : ""}`} data-language={language}>
    <CopyButton label={copyLabel} value={text} preserveTrailingNewline />
    <pre aria-label={label} tabIndex={0}><code className="shiki" dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
  </div>;
}
