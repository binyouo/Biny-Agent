import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough";

// Match the renderer's emphasis and strikethrough grammar. Math and HTML are not
// interpreted here: this is a conservative text copy, not another renderer.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })
  .use(remarkCjkFriendly).use(remarkCjkStrikethrough, { singleTilde: false }).freeze();

interface TextNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: readonly TextNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Flatten recognized formatting without treating literal punctuation as markup. */
export function markdownPlainText(content: string): string {
  const render = (node: TextNode, inContainer = false): string => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? content.length;
    if (node.type === "code" || node.type === "inlineCode") return node.value ?? "";
    if (node.type === "text") {
      const source = content.slice(start, end);
      const lines = source.split(/(\r\n|\n|\r)/u);
      const values = (node.value ?? "").split(/\r\n|\n|\r/u);
      // Text values decode escapes/entities, but also omit continuation markers.
      // Keep those source prefixes and line endings without rescanning literals.
      if (values.length * 2 - 1 !== lines.length) return source;
      // Leading entities can introduce indentation that was not in the source.
      // Do not subtract that decoded whitespace from a list/quote prefix.
      if (lines.some((line, index) => index > 0 && index % 2 === 0
        && line.replace(inContainer ? /^[\t >]*/u : /^[\t ]*/u, "").startsWith("&")
        && /^[\t ]/u.test(values[index / 2]!))) return source;
      return lines.map((line, index) => {
        if (index % 2) return line;
        const value = values[index / 2]!;
        if (index === 0) return value;
        const prefix = line.match(inContainer ? /^[\t >]*/u : /^[\t ]*/u)![0];
        const valuePrefix = value.match(/^[\t ]*/u)![0];
        return prefix.endsWith(valuePrefix) ? prefix.slice(0, prefix.length - valuePrefix.length) + value : line;
      }).join("");
    }
    if (node.type === "image") return node.alt ?? "";
    if (["heading", "emphasis", "strong", "delete", "link"].includes(node.type)) {
      return node.children?.map(child => render(child, inContainer)).join("") ?? "";
    }
    // Keep container markers, original gaps, HTML and reference definitions.
    // Code values above are terminal and never pass through this traversal again.
    let cursor = start;
    let result = "";
    for (const child of node.children ?? []) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined) continue;
      result += content.slice(cursor, childStart) + render(child, inContainer || node.type === "blockquote" || node.type === "listItem");
      cursor = childEnd;
    }
    return result + content.slice(cursor, end);
  };
  return render(parser.parse(content)).trim();
}
