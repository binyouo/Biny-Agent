/** Markdown 渲染块的边界；引用定义必须保留整篇作用域。 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

function parseBlocks(content: string): { blocks: string[]; documentScope: boolean } {
  const tree = parser.parse(content);
  // 链接/脚注可在后续任意块定义，包含这些定义的文档需要共享解析作用域。
  const hasDefinition = (node: { type: string; children?: readonly { type: string }[] }): boolean =>
    node.type === "definition" || node.type === "footnoteDefinition" || Boolean(node.children?.some(hasDefinition));
  const documentScope = hasDefinition(tree);
  if (tree.children.length < 2 || documentScope) return { blocks: [content], documentScope };
  const starts = tree.children.map((node, index) => {
    if (index === 0) return 0;
    const offset = node.position!.start.offset!;
    // 保留行首缩进；语法节点的 offset 可能位于首个非空白字符。
    return content.lastIndexOf("\n", offset - 1) + 1;
  });
  return { blocks: starts.map((start, index) => content.slice(start, starts[index + 1])), documentScope: false };
}

export function splitMarkdownBlocks(content: string): string[] {
  return parseBlocks(content).blocks;
}

/** 单条正文独享缓存；只追加时重新解析末尾两块，替换/删除自动重新解析。 */
export function createMarkdownBlockParser(): (content: string) => string[] {
  let previous = "";
  let blocks = [""];
  let documentScope = false;
  return (content) => {
    if (content === previous) return blocks;
    const prefix = !documentScope && content.startsWith(previous) ? blocks.slice(0, -2) : [];
    const offset = prefix.reduce((length, block) => length + block.length, 0);
    const tail = parseBlocks(content.slice(offset));
    documentScope = tail.documentScope;
    // 后置定义可能使已展示的引用生效，必须撤销全部分块并共享完整文档作用域。
    blocks = documentScope ? [content] : [...prefix, ...tail.blocks];
    previous = content;
    return blocks;
  };
}
