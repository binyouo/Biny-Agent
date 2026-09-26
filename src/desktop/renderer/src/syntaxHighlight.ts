/**
 * 代码高亮（Shiki）。
 *
 * 全渲染进程共享一个按需初始化的 highlighter；语言按需 `loadLanguage`，
 * 未预载的语法由打包器自然切成独立 chunk，用到才拉取。主题一次高亮同时输出
 * github-light / github-dark 两组颜色 CSS 变量，明暗切换纯靠 CSS，不重新高亮。
 *
 * 渲染的是模型输出，一切外部内容都当不可信处理：Shiki 自带转义；识别不出语言、
 * 超长或高亮抛错时，退回自行转义的纯文本——结果要作为 HTML 插进 DOM，不能把
 * 未转义的文件内容直接交出去。
 */
import { bundledLanguages } from "shiki/langs";
import type { BundledLanguage, Highlighter } from "shiki";

/** 双主题输出 `--shiki-light` / `--shiki-dark` 变量，由全局 CSS 按 data-theme 取值。 */
const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

let highlighterPromise: Promise<Highlighter> | undefined;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  // 首屏不编译未使用的语法；没有代码块的页面无需加载高亮引擎。
  highlighterPromise ??= import("shiki").then(({ createHighlighter, createJavaScriptRegexEngine }) => createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })).catch((error: unknown) => { highlighterPromise = undefined; throw error; });
  return highlighterPromise;
}

/**
 * 超过这个长度就不高亮。
 *
 * 流式输出时代码块每来一个增量都会重新高亮一次，长文本上这个开销会直接卡住渲染。
 */
const highlightLimit = 40_000;

export interface HighlightedCode {
  html: string;
  language?: string;
}

/** 扩展名 → Shiki 语言 id。多个扩展名可以复用同一套语法（如 .vue 用 vue、.zsh 用 bash）。 */
const languageByExtension: Record<string, string> = {
  bash: "bash",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash"
};

// Markdown 代码块的语言标注不一定和扩展名一致，这里补上常见写法。
const languageByFence: Record<string, string> = {
  console: "shellscript",
  golang: "go",
  htm: "html",
  html: "html",
  shell: "shellscript",
  svg: "xml"
};

export function highlightWorkspaceFile(filePath: string, content: string): Promise<HighlightedCode> {
  return highlight(content, languageForPath(filePath));
}

/** 高亮 Markdown 围栏代码块；`fence` 是 ``` 后面那段语言标注。 */
export function highlightFencedCode(content: string, fence?: string): Promise<HighlightedCode> {
  return highlight(content, languageForFence(fence));
}

async function highlight(content: string, language?: string): Promise<HighlightedCode> {
  if (!language || content.length > highlightLimit || !(language in bundledLanguages)) {
    return { html: escapeHtml(content), language };
  }
  try {
    const highlighter = await getHighlighter();
    // 上面已确认语言在 bundledLanguages 里，这里的强转只是类型收窄
    const lang = language as BundledLanguage;
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      // 未预载的语言按需加载；打包器会把它和 shiki 的语法注册表拆成独立 chunk
      let pending = languageLoads.get(lang);
      if (!pending) {
        pending = highlighter.loadLanguage(lang).finally(() => { languageLoads.delete(lang); });
        languageLoads.set(lang, pending);
      }
      await pending;
    }
    const html = highlighter.codeToHtml(content, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false
    });
    return { html: stripPreWrapper(html), language };
  } catch {
    return { html: escapeHtml(content), language };
  }
}

/** Shiki 输出是完整的 `<pre><code>`，剥掉外壳，消费方用自己的 pre/code 结构承载。 */
function stripPreWrapper(html: string): string {
  const match = /^<pre[^>]*><code[^>]*>([\s\S]*)<\/code><\/pre>$/.exec(html.trim());
  // 不匹配时（shiki 输出格式变化）宁可整段转义，也不能把未转义内容交给 innerHTML
  return match?.[1] ?? escapeHtml(html);
}

export function languageForFence(fence?: string): string | undefined {
  const name = fence?.trim().toLocaleLowerCase();
  if (!name) return undefined;
  // 显式映射优先（保证标签给规范 id），其余交给 shiki 自带的别名表
  return languageByFence[name] ?? languageByExtension[name] ?? (name in bundledLanguages ? name : undefined);
}

export function languageForPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "docker";
  const extension = name.split(".").at(-1);
  return extension ? languageByExtension[extension] : undefined;
}

/** 无高亮时也必须转义：返回值会以 innerHTML 的方式渲染。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}
