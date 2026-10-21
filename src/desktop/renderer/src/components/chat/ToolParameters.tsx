import React from "react";
import { ToolCodeBlock } from "./ToolCodeBlock.js";

const codeFields = /^(code|script|source|content|sql|query|patch|diff|body|html|css|svg|markdown|md|template|prompt)$/iu;

export function ToolParameters({ args, toolName }: { args: unknown; toolName?: string }): React.JSX.Element | null {
  if (args === undefined) return null;
  const fields = args !== null && typeof args === "object" && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>) : [["arguments", args] as const];
  const language = args !== null && typeof args === "object" && "language" in args && typeof args.language === "string" ? args.language : undefined;
  const isBlock = ([name, value]: readonly [string, unknown]): boolean => {
    if (value !== null && typeof value === "object") return true;
    if (typeof value !== "string") return false;
    if (toolName === "WebSearch" && name === "query") return false;
    return codeFields.test(name) || value.includes("\n") || value.length > 120;
  };
  const scalars = fields.filter(field => !isBlock(field));
  const blocks = fields.filter(isBlock);
  return <section className="tool-parameters" aria-label="工具参数">
    <h4 className="tool-section-label">参数</h4>
    {scalars.length ? <dl className="tool-parameter-list">{scalars.map(([name, value]) => <div className="tool-parameter" key={name}>
      <dt className="tool-parameter-name">{name}</dt>
      <dd className="tool-parameter-value" aria-label={`参数 ${name}`}>{typeof value === "string" ? value || '""' : String(value)}</dd>
    </div>)}</dl> : null}
    {blocks.map(([name, value]) => <div className="tool-parameter is-block" key={name}>
      <span className="tool-parameter-name">{name}</span>
      <ToolCodeBlock label={`参数 ${name}`} copyLabel={`复制参数 ${name}`} text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} language={typeof value === "object" ? "json" : parameterLanguage(name, language)} dashed />
    </div>)}
    {!fields.length ? <p className="tool-parameters-empty">无参数</p> : null}
  </section>;
}

function parameterLanguage(name: string, hint?: string): string {
  switch (name.toLowerCase()) {
    case "code": case "script": case "source": return hint ?? "typescript";
    case "sql": case "query": return "sql";
    case "patch": case "diff": return "diff";
    case "html": return "html";
    case "css": return "css";
    case "svg": return "xml";
    case "markdown": case "md": return "markdown";
    default: return hint ?? "text";
  }
}
