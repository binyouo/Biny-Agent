/** 静态图表渲染；模型源码与渲染器输出都经过安全边界。 */
import { renderMermaidSVG } from "beautiful-mermaid";
import createDOMPurify from "dompurify";
import { readThemeColors } from "../../themeColors.js";

export const DIAGRAM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export interface DiagramTheme {
  dark: boolean;
  colors: ReturnType<typeof readDiagramColors>;
}

export function readDiagramColors() {
  return readThemeColors(document.body, {
    background: "--bg", primaryColor: "--surface-soft", primaryTextColor: "--text", primaryBorderColor: "--border-strong",
    lineColor: "--text-secondary", textColor: "--text", secondaryColor: "--accent-soft", secondaryTextColor: "--text",
    secondaryBorderColor: "--accent", tertiaryColor: "--surface-raised", tertiaryTextColor: "--text", tertiaryBorderColor: "--border",
    noteBkgColor: "--amber-bg", noteTextColor: "--amber-text", noteBorderColor: "--amber",
    edgeLabelBackground: "--surface-raised", clusterBkg: "--surface-soft", clusterBorder: "--border", titleColor: "--text"
  });
}

/** 保留本地图形引用；禁止 SVG 从模型文字引入脚本、事件、HTML、远程资源或动画。 */
let svgSequence = 0;

export function sanitizeDiagramSvg(svg: string, namespace = `biny-diagram-${++svgSequence}`): string {
  const sanitized = createDOMPurify(window).sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script", "image", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["tabindex"]
  });
  const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("图表渲染结果无效");
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      if (name === "href" && !/^#[\w:.-]+$/u.test(attribute.value)) element.removeAttributeNode(attribute);
      if (name.startsWith("on")) element.removeAttributeNode(attribute);
      if (name === "style" || /url\s*\(/iu.test(attribute.value)) {
        const cleaned = staticSvgCss(attribute.value);
        if (cleaned) {
          if (name === "style") {
            const declaration = document.createElement("span").style;
            declaration.cssText = cleaned;
            sanitizePresentationStyles(declaration);
            element.setAttribute(attribute.name, declaration.cssText);
          } else element.setAttribute(attribute.name, cleaned);
        }
        else element.removeAttributeNode(attribute);
      }
    }
    if (element.localName === "style") element.textContent = staticSvgCss(element.textContent ?? "");
  }
  isolateSvgReferences(root, namespace);
  return new XMLSerializer().serializeToString(root);
}

function staticSvgCss(css: string): string {
  const localFont = css.replace(/\s*@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com[^;]*;/giu, "");
  // 转义 CSS、规则导入及图片函数没有展示需要；不让 URL 的转义写法绕过本地引用检查。
  if (/\\/u.test(localFont) || /(?:https?:|data:|javascript:|image-set\s*\(|@(?:import|font-face))/iu.test(localFont)) return "";
  const urls = localFont.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/giu);
  for (const url of urls) if (!/^#[\w:.-]+$/u.test(url[2] ?? "")) return "";
  return localFont;
}

const SVG_STYLE_PROPERTIES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "font", "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-feature-settings", "font-kerning", "font-synthesis", "line-height", "letter-spacing", "word-spacing",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "white-space", "text-decoration", "text-transform", "text-overflow", "writing-mode", "text-orientation", "text-rendering",
  "color", "background", "background-color", "opacity", "visibility", "display", "overflow", "pointer-events", "cursor", "paint-order", "vector-effect", "shape-rendering", "color-interpolation", "color-interpolation-filters",
  "clip-path", "clip-rule", "mask", "filter", "transform", "transform-origin", "width", "height", "max-width", "max-height", "min-width", "min-height",
  "animation", "animation-name", "animation-duration", "animation-timing-function", "animation-delay", "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state"
]);

function sanitizePresentationStyles(style: CSSStyleDeclaration): void {
  for (const property of Array.from(style)) if (!property.startsWith("--") && !SVG_STYLE_PROPERTIES.has(property)) style.removeProperty(property);
}

/** 每个展示槽独立持有 ID 与 CSS；多图的 marker、clipPath 和规则不能相互覆盖。 */
function isolateSvgReferences(root: Element, namespace: string): void {
  const ids = new Map<string, string>();
  const oldRoot = root.getAttribute("id");
  if (oldRoot) ids.set(oldRoot, namespace);
  root.setAttribute("id", namespace);
  for (const element of Array.from(root.querySelectorAll("[id]"))) {
    const id = element.getAttribute("id")!;
    const fresh = `${namespace}-${ids.size}`;
    ids.set(id, fresh);
    element.setAttribute("id", fresh);
  }
  const replaceUrls = (value: string) => value.replace(/url\s*\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/giu, (_match: string, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : "none");
  const replaceSelectorIds = (selector: string) => {
    let result = selector;
    for (const [old, fresh] of ids) {
      const escaped = old.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      result = result.replace(new RegExp(`#${escaped}(?=[^\\w-]|$)`, "gu"), `#${fresh}`);
    }
    return result;
  };
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.localName === "href" && attribute.value.startsWith("#")) {
        const id = ids.get(attribute.value.slice(1));
        if (id) attribute.value = `#${id}`;
        else element.removeAttributeNode(attribute);
      } else if (attribute.localName === "aria-labelledby" || attribute.localName === "aria-describedby") {
        attribute.value = attribute.value.split(/\s+/u).map(id => ids.get(id) ?? id).join(" ");
      } else if (attribute.localName !== "id") attribute.value = replaceUrls(attribute.value);
    }
    if (element.localName !== "style") continue;
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync(replaceUrls(element.textContent ?? ""));
    const rules: string[] = [];
    const animations = new Map<string, string>();
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type === 7) {
        const keyframes = rule as CSSKeyframesRule;
        for (const frame of Array.from(keyframes.cssRules)) sanitizePresentationStyles((frame as CSSKeyframeRule).style);
        const name = `${namespace}-${keyframes.name}`;
        animations.set(keyframes.name, name);
        rules.push(keyframes.cssText.replace(keyframes.name, name));
      }
    }
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type !== 1) continue;
      const style = rule as CSSStyleRule;
      sanitizePresentationStyles(style.style);
      for (const [old, fresh] of animations) {
        for (const property of ["animation", "animation-name"]) {
          const value = style.style.getPropertyValue(property);
          if (value) style.style.setProperty(property, value.replaceAll(old, fresh));
        }
      }
      const selector = replaceSelectorIds(style.selectorText);
      rules.push(`#${namespace}:is(${selector}), #${namespace} :is(${selector}) { ${style.style.cssText} }`);
    }
    element.textContent = rules.join("\n");
  }
}

/** 输入修正只覆盖展示歧义：重复无名分组、样式色函数逗号、显式底色文字对比。 */
export function normalizeDiagramSource(code: string): string {
  const normalized = code.replace(/^(\s*(?:classDef|style|linkStyle)\s.*)$/gmu, line => line.replace(/\b(rgba?|hsla?)\(([^()]*)\)/giu, (match: string, fn: string, args: string) => {
    if (!args.includes(",")) return match;
    const parts = args.split(",").map(part => part.trim());
    return parts.length === 4 ? `${fn}(${parts.slice(0, 3).join(" ")} / ${parts[3]})` : `${fn}(${parts.join(" ")})`;
  })).replace(/^(\s*(?:classDef|style)\s+\S+\s+)(.+?)(;?)\s*$/gmu, (line: string, head: string, props: string, semi: string) => {
    if (/(^|[\s,])color\s*:/iu.test(props)) return line;
    const fill = props.match(/(?:^|[\s,])fill\s*:\s*([^,;]+)/iu);
    const rgb = fill?.[1] ? parseOpaqueColor(fill[1]) : undefined;
    if (!rgb) return line;
    const [red = 0, green = 0, blue = 0] = rgb.map(channel => {
      const value = channel / 255;
      return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return `${head}${props},color:${.2126 * red + .7152 * green + .0722 * blue > .18 ? "#1f2328" : "#f6f8fa"}${semi}`;
  });
  const seen = new Set<string>();
  let next = 0;
  return normalized.replace(/^(\s*)subgraph\s+(.+?)\s*$/gmu, (line: string, indent: string, rest: string) => {
    const explicit = rest.match(/^([\w-]+)\s*\[/u);
    const id = explicit?.[1] ?? rest.replace(/\s+/gu, "_").replace(/[^\w]/gu, "");
    if (explicit || (id && !seen.has(id))) { seen.add(id); return line; }
    while (seen.has(`subgraph_${next}`)) next++;
    const fresh = `subgraph_${next++}`;
    seen.add(fresh);
    return `${indent}subgraph ${fresh}[${rest}]`;
  });
}

function parseOpaqueColor(value: string): number[] | undefined {
  const color = value.trim().toLowerCase();
  const hex = color.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map(channel => channel + channel).join("") : hex;
    if (expanded.length === 8 && parseInt(expanded.slice(6, 8), 16) < 153) return undefined;
    return [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16));
  }
  const fn = color.match(/^(rgba?|hsla?)\(([^()]*)\)$/u);
  if (!fn?.[1] || !fn[2]) return undefined;
  const [channels = "", alpha] = fn[2].split("/").map(part => part.trim());
  if (alpha !== undefined && (alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha)) < .6) return undefined;
  const values = channels.split(/\s+/u).map(parseFloat);
  if (values.length < 3 || values.some(Number.isNaN)) return undefined;
  if (fn[1].startsWith("rgb")) return values.slice(0, 3);
  const [hue = 0, saturation = 0, lightness = 0] = values;
  const luminance = lightness / 100;
  const magnitude = saturation / 100 * Math.min(luminance, 1 - luminance);
  return [0, 8, 4].map(offset => {
    const phase = (offset + hue / 30) % 12;
    return 255 * (luminance - magnitude * Math.max(-1, Math.min(phase - 3, 9 - phase, 1)));
  });
}

export interface RenderedDiagram { code: string; svg: string; background: string }

export function renderBeautifulDiagram(code: string, theme: DiagramTheme, isStreaming = false): RenderedDiagram | undefined {
  const render = (source: string): RenderedDiagram | undefined => {
    try {
      const svg = renderMermaidSVG(normalizeDiagramSource(source), {
        bg: theme.colors.background, fg: theme.colors.textColor, accent: theme.colors.secondaryBorderColor,
        border: theme.colors.clusterBorder, muted: theme.colors.lineColor, transparent: true, padding: 24
      }).replace(/font-family:\s*'[^']*',\s*system-ui,\s*sans-serif;/gu, `font-family: ${DIAGRAM_FONT};`);
      return { code: source, svg: sanitizeDiagramSvg(svg), background: theme.colors.background };
    } catch { return undefined; }
  };
  const source = code.trim();
  if (!source) return undefined;
  const newline = source.lastIndexOf("\n");
  if (isStreaming && newline > 0 && source.slice(newline + 1).trim()) {
    const prefix = render(source.slice(0, newline));
    if (prefix) return prefix;
  }
  return render(source);
}

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidPromise: Promise<MermaidApi> | undefined;
let initializedTheme: string | undefined;
let renderSequence = 0;
let rendering: Promise<unknown> = Promise.resolve();

/** Mermaid 的全局配置与渲染器串行，避免并发图块读到另一份主题或临时节点。 */
export function renderStandardDiagram(source: string, theme: DiagramTheme, signal: AbortSignal): Promise<RenderedDiagram> {
  const work = async (): Promise<RenderedDiagram> => {
    signal.throwIfAborted();
    const mermaid = await (mermaidPromise ??= import("mermaid").then(module => module.default));
    signal.throwIfAborted();
    const themeVariables = { darkMode: theme.dark, ...theme.colors };
    const configKey = JSON.stringify(themeVariables);
    if (initializedTheme !== configKey) {
      mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables, securityLevel: "strict", fontFamily: DIAGRAM_FONT,
        htmlLabels: false, suppressErrorRendering: true });
      initializedTheme = configKey;
    }
    const id = `biny-mermaid-${++renderSequence}`;
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-99999px";
    container.style.top = "-99999px";
    document.body.appendChild(container);
    const previousLayoutNodes = new Set(document.querySelectorAll("body > div#cy"));
    try {
      const { svg } = await mermaid.render(id, source, container);
      signal.throwIfAborted();
      return { code: source, svg: sanitizeDiagramSvg(svg), background: theme.colors.background };
    } finally {
      container.remove();
      document.querySelectorAll(`svg[id^="${id}"], #d${id}`).forEach(element => { if (element.parentElement === document.body) element.remove(); });
      // 图布局依赖在失败前可能将画布容器附到 body，串行请求只清理本次新增节点。
      document.querySelectorAll<HTMLElement>("body > div#cy").forEach(element => { if (!previousLayoutNodes.has(element) && element.style.display === "none") element.remove(); });
    }
  };
  const request = rendering.then(work, work);
  rendering = request.then(() => undefined, () => undefined);
  return request;
}
