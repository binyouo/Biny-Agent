/** Budgets bound newly selected schemas without evicting accumulated or required tools. */
import type { Tool } from "../tools/types.js";

export interface AutomaticToolBudget {
  maxTools: number;
  /** Serialized JSON characters, not a tokenizer-dependent token estimate. */
  maxSchemaCharacters: number;
}

/** Conservative starting policy; callers may tune it without changing explicit selection semantics. */
export const defaultAutomaticToolBudget: Readonly<AutomaticToolBudget> = Object.freeze({
  maxTools: 32, maxSchemaCharacters: 64_000
});

export type PreselectionTool = Pick<Tool, "name" | "description" | "source" | "capability"> & Partial<Pick<Tool, "parameters" | "exposure">>;

export function boundAutomaticTools(options: {
  tools: readonly PreselectionTool[];
  required: ReadonlySet<string>;
  current: readonly string[];
  previous: readonly string[];
  budget?: Partial<AutomaticToolBudget>;
}): string[] {
  const budget = { ...defaultAutomaticToolBudget, ...options.budget };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid automatic tool budget: ${key}`);
  }
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const selected = new Set([...options.required, ...options.previous].filter((name) => byName.has(name)));
  let count = 0;
  let characters = 0;
  const add = (name: string): void => {
    // Web search/fetch is a small declared bundle, not a server-wide expansion.
    const names = name === "WebSearch" || name === "WebFetch" ? ["WebSearch", "WebFetch"] : [name];
    const entries = names.filter((entry) => !selected.has(entry)).flatMap((entry) => {
      const tool = byName.get(entry);
      return tool ? [tool] : [];
    });
    if (!entries.length) return;
    if (count + entries.length > budget.maxTools) return;
    const size = entries.reduce((sum, tool) => sum + JSON.stringify({
      name: tool.name, description: tool.description, parameters: tool.parameters ?? {}
    }).length, 0);
    if (characters + size > budget.maxSchemaCharacters) return;
    for (const tool of entries) selected.add(tool.name);
    count += entries.length;
    characters += size;
  };
  for (const name of options.current) add(name);
  return [...selected];
}
