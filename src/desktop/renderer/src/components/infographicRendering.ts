/** 信息图只接收 DSL 与静态资源，第三方原始 SVG 不进入聊天正文。 */
import type { Data, InfographicOptions, ItemDatum } from "@antv/infographic";
import createDOMPurify from "dompurify";

export interface InfographicTheme { dark: boolean; background: string; primary: string; palette: string[]; font: string }
export interface RenderedInfographic { code: string; svg: string; background: string; resourceErrors: number }
const RESOURCE_LIMIT = 2 * 1024 * 1024;
let libraryPromise: Promise<typeof import("@antv/infographic")> | undefined;

async function infographicLibrary() {
  return libraryPromise ??= import("@antv/infographic").then(library => {
    // 图形字体使用已有系统字体；库默认会向 head 插入所有注册字体的远程 CSS。
    for (const font of library.getFonts()) library.registerFont({ ...font, fontFamily: font.fontFamily.replace(/^(['"])(.*)\1$/u, "$2"), fontWeight: {} });
    library.setDefaultFont("sans-serif");
    return library;
  }).catch(error => { libraryPromise = undefined; throw error; });
}

export function normalizeInfographicSource(source: string): string {
  const lines = source.trim().split("\n");
  if (!lines[0]?.trim().startsWith("infographic ")) lines[0] = `infographic ${lines[0]?.trim() ?? ""}`;
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^theme(?:\s|$)/u.test(line.trim())) {
      const indent = line.match(/^\s*/u)![0].length;
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() && next.match(/^\s*/u)![0].length <= indent) break;
        index++;
      }
    } else result.push(line);
  }
  return result.join("\n");
}

/** 净化 SVG 图形，栅格资源只允许已读取并有界的内联图片。 */
export async function sanitizeInfographicSvg(source: string): Promise<string> {
  const { sanitizeDiagramSvg } = await import("./diagram/diagramRendering.js");
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const images = new Map<string, SVGElement>();
  const textObjects = new Map<string, SVGElement>();
  for (const object of Array.from(parsed.querySelectorAll("foreignObject"))) {
    const fragment = createDOMPurify(window).sanitize(object.innerHTML, { ALLOWED_TAGS: ["span", "div", "p", "br", "strong", "em", "b", "i"], ALLOWED_ATTR: ["style"], RETURN_DOM_FRAGMENT: true });
    for (const element of Array.from(fragment.querySelectorAll<HTMLElement>("[style]"))) {
      const style = element.style;
      for (const property of Array.from(style)) {
        const value = style.getPropertyValue(property);
        if (!/^(?:color|font-family|font-size|font-weight|font-style|line-height|letter-spacing|text-align|text-decoration|text-transform|white-space|word-break|overflow-wrap|display|flex-wrap|justify-content|align-content|align-items|width|height|overflow)$/u.test(property) || /[\\@]/u.test(value) || /(?:url|image-set|expression)\s*\(|(?:https?:|data:|javascript:)/iu.test(value)) style.removeProperty(property);
      }
    }
    const key = String(textObjects.size);
    const placeholder = parsed.createElementNS("http://www.w3.org/2000/svg", "g");
    placeholder.setAttribute("data-static-text", key);
    for (const name of ["x", "y", "width", "height", "transform", "opacity", "clip-path", "overflow"]) {
      const value = object.getAttribute(name);
      if (value !== null) placeholder.setAttribute(name, value);
    }
    const clean = parsed.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    clean.append(...Array.from(fragment.childNodes).map(node => parsed.importNode(node, true)));
    textObjects.set(key, clean);
    object.replaceWith(placeholder);
  }
  for (const image of Array.from(parsed.querySelectorAll("image"))) {
    const href = image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
    if (href.length > RESOURCE_LIMIT * 1.4 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/u.test(href)) { image.remove(); continue; }
    const key = String(images.size);
    const placeholder = parsed.createElementNS("http://www.w3.org/2000/svg", "g");
    placeholder.setAttribute("data-static-image", key);
    for (const name of ["x", "y", "width", "height", "transform", "opacity", "clip-path", "preserveAspectRatio"]) {
      const value = image.getAttribute(name);
      if (value !== null) placeholder.setAttribute(name, value);
    }
    const clean = parsed.createElementNS("http://www.w3.org/2000/svg", "image");
    clean.setAttribute("href", href);
    images.set(key, clean);
    image.replaceWith(placeholder);
  }
  const safe = new DOMParser().parseFromString(sanitizeDiagramSvg(new XMLSerializer().serializeToString(parsed.documentElement)), "image/svg+xml");
  for (const placeholder of Array.from(safe.querySelectorAll("[data-static-image]"))) {
    const image = images.get(placeholder.getAttribute("data-static-image")!);
    if (!image) { placeholder.remove(); continue; }
    for (const attribute of Array.from(placeholder.attributes)) if (attribute.name !== "data-static-image") image.setAttribute(attribute.name, attribute.value);
    placeholder.replaceWith(safe.importNode(image, true));
  }
  for (const placeholder of Array.from(safe.querySelectorAll("[data-static-text]"))) {
    const object = textObjects.get(placeholder.getAttribute("data-static-text")!);
    if (!object) { placeholder.remove(); continue; }
    for (const attribute of Array.from(placeholder.attributes)) if (attribute.name !== "data-static-text") object.setAttribute(attribute.name, attribute.value);
    placeholder.replaceWith(safe.importNode(object, true));
  }
  return new XMLSerializer().serializeToString(safe.documentElement);
}

async function readResource(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
  const parsed = new URL(url);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("不支持的信息图资源地址");
  const response = await fetch(parsed.href, { credentials: "omit", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(6_000)]) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > RESOURCE_LIMIT) throw new Error("信息图资源无法读取");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > RESOURCE_LIMIT) throw new Error("信息图资源过大");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, type: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "" };
}

async function resourceSvg(value: string, label: string, signal: AbortSignal, depth = 0): Promise<string> {
  signal.throwIfAborted();
  if (depth > 1) throw new Error("信息图资源引用过深");
  if (value.startsWith("ref:svg:")) value = value.slice(8);
  if (value.trim().startsWith("<svg") || value.trim().startsWith("<symbol")) {
    const source = value.trim().replace(/^<symbol\b/u, "<svg").replace(/<\/symbol>\s*$/u, "</svg>");
    return sanitizeInfographicSvg(source);
  }
  if (/^data:image\//u.test(value)) {
    if (value.length > RESOURCE_LIMIT * 1.4) throw new Error("信息图资源过大");
    if (value.startsWith("data:image/svg+xml,")) return sanitizeInfographicSvg(decodeURIComponent(value.slice(value.indexOf(",") + 1)));
    if (value.startsWith("data:image/svg+xml;base64,")) return sanitizeInfographicSvg(new TextDecoder().decode(Uint8Array.from(atob(value.slice(value.indexOf(",") + 1)), character => character.charCodeAt(0))));
    return sanitizeInfographicSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image width="100" height="100" href="${value}"/></svg>`);
  }
  const remote = value.replace(/^ref:(?:url|remote):(?:svg:|png:|jpg:|jpeg:|webp:|gif:)?/u, "");
  if (/^https?:\/\//u.test(remote)) {
    const { bytes, type } = await readResource(remote, signal);
    if (type === "image/svg+xml" || new TextDecoder().decode(bytes.slice(0, 200)).trim().startsWith("<svg")) return sanitizeInfographicSvg(new TextDecoder().decode(bytes));
    if (!/^image\/(?:png|jpeg|webp|gif)$/u.test(type)) throw new Error("不支持的信息图资源格式");
    let binary = "";
    for (let index = 0; index < bytes.length; index += 16_384) binary += String.fromCharCode(...bytes.subarray(index, index + 16_384));
    return sanitizeInfographicSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image width="100" height="100" href="data:${type};base64,${btoa(binary)}"/></svg>`);
  }
  if (/^ref:(?:url|remote):/u.test(value) || /^(?:javascript|data|file|blob):/iu.test(value) || /[<>"'\\]/u.test(value)) throw new Error("不支持的信息图资源地址");
  const query = value.startsWith("ref:search:") ? value.replace(/^ref:search:(?:svg:)?/u, "") : label || value;
  const url = `https://www.weavefox.cn/api/open/v1/icon?${new URLSearchParams({ text: query, topK: "1" })}`;
  const { bytes } = await readResource(url, signal);
  const result = JSON.parse(new TextDecoder().decode(bytes)) as { status?: boolean; data?: { data?: unknown[] } };
  const icon = result.status ? result.data?.data?.[0] : undefined;
  if (typeof icon !== "string" || !/^(?:<svg|<symbol|data:image\/|https?:\/\/)/u.test(icon.trim())) throw new Error("信息图图标无法读取");
  return resourceSvg(icon, "", signal, depth + 1);
}

async function prepareData(data: Data, signal: AbortSignal): Promise<{ data: Data; resourceErrors: number }> {
  const assets = new Map<string, Promise<ItemDatum["icon"]>>();
  let resourceErrors = 0;
  const asset = (value: ItemDatum["icon"], label: string): Promise<ItemDatum["icon"]> => {
    if (!value) return Promise.resolve(undefined);
    const source = typeof value === "string" ? value : value.data;
    const key = `${source}\n${label}`;
    if (!assets.has(key)) {
      if (assets.size >= 64) { resourceErrors++; return Promise.resolve(undefined); }
      assets.set(key, resourceSvg(source, label, signal).then(svg => ({ source: "inline" as const, format: "svg", encoding: "raw", data: svg })).catch(() => {
        signal.throwIfAborted();
        resourceErrors++;
        return undefined;
      }));
    }
    return assets.get(key)!;
  };
  const item = async (value: ItemDatum): Promise<ItemDatum> => ({ ...value, icon: await asset(value.icon, value.label ?? ""), illus: await asset(value.illus, value.label ?? ""), children: value.children ? await Promise.all(value.children.map(item)) : undefined });
  const illus = data.illus ? Object.fromEntries((await Promise.all(Object.entries(data.illus).map(async ([key, value]) => [key, await asset(value, key)] as const))).filter((entry): entry is readonly [string, NonNullable<ItemDatum["icon"]>] => entry[1] !== undefined)) : undefined;
  const items = await Promise.all(data.items.map(item));
  return { data: { ...data, items, illus }, resourceErrors };
}

export async function renderInfographic(code: string, width: number, theme: InfographicTheme, signal: AbortSignal): Promise<RenderedInfographic> {
  signal.throwIfAborted();
  const library = await infographicLibrary();
  signal.throwIfAborted();
  const source = normalizeInfographicSource(code);
  const parsed = library.parseSyntax(source);
  if (parsed.errors.length || !parsed.options.data?.items?.length) throw new Error("信息图源码尚未完整");
  const designText = JSON.stringify(parsed.options.design);
  if (designText && /(?:\\\\|url\s*\(|(?:https?:|data:|javascript:)|@(?:import|font-face)|expression\s*\(|<\/?(?:script|iframe|object|embed))/iu.test(designText)) throw new Error("信息图设计包含不支持的主动引用");
  const { data, resourceErrors } = await prepareData(parsed.options.data, signal);
  signal.throwIfAborted();
  const staging = document.createElement("div");
  staging.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none";
  const instance = new library.Infographic({ container: staging, width: Math.max(width || 600, 400), padding: 20, editable: false, theme: theme.dark ? "dark" : "default" });
  const themeOptions: Partial<InfographicOptions> = { theme: theme.dark ? "dark" : "default", themeConfig: { colorBg: theme.background, colorPrimary: theme.primary, palette: theme.palette, base: { text: { "font-family": theme.font } } } };
  let renderError: unknown;
  const onError = (error: unknown) => { renderError = error; };
  instance.on("error", onError);
  const stage = async (render: () => void) => {
    let complete: () => void = () => undefined;
    const loaded = new Promise<void>(resolve => { complete = resolve; });
    instance.on("loaded", complete);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    try {
      staging.remove();
      render();
      if (renderError) throw new Error("信息图渲染失败");
      const svg = staging.querySelector("svg");
      if (!svg) throw new Error("信息图渲染失败");
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("信息图渲染超时")), 1_000); });
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
      await Promise.race([loaded, timeout, aborted]);
      // 同一原始节点经净化后才参与尺寸测量，让库的 DOM 观察器正常收尾。
      const safe = new DOMParser().parseFromString(await sanitizeInfographicSvg(svg.outerHTML), "image/svg+xml").documentElement;
      for (const attribute of Array.from(svg.attributes)) svg.removeAttributeNode(attribute);
      for (const attribute of Array.from(safe.attributes)) svg.setAttribute(attribute.name, attribute.value);
      svg.replaceChildren(...Array.from(safe.childNodes).map(node => document.importNode(node, true)));
      if (!staging.isConnected) document.body.append(staging);
      await new Promise<void>(resolve => queueMicrotask(resolve));
      signal.throwIfAborted();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      instance.off("loaded", complete);
      const abandoned = staging.querySelector("svg");
      if (abandoned && !staging.isConnected) {
        // 库的观察器只在原始 SVG 接入文档时收尾；取消时接入空白节点再销毁。
        for (const attribute of Array.from(abandoned.attributes)) abandoned.removeAttributeNode(attribute);
        abandoned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        abandoned.setAttribute("width", "40");
        abandoned.setAttribute("height", "40");
        abandoned.replaceChildren();
        document.body.append(staging);
        await new Promise<void>(resolve => queueMicrotask(resolve));
      }
    }
  };
  try {
    // 解析器提供模板、设计和数据；容器、主动属性、编辑和主题控制由展示层持有。
    await stage(() => instance.render({ template: parsed.options.template, design: parsed.options.design, data }));
    await stage(() => instance.update(themeOptions));
    const svg = staging.querySelector("svg");
    if (!svg) throw new Error("信息图渲染失败");
    const result = await sanitizeInfographicSvg(svg.outerHTML);
    signal.throwIfAborted();
    return { code: code.trim(), svg: result, background: theme.background, resourceErrors };
  } finally { instance.destroy(); staging.remove(); }
}

/** 静态文字图形使用内联 SVG 地址绘制，两倍像素并限制极端画布尺寸。 */
export async function infographicPng(diagram: RenderedInfographic, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const library = await infographicLibrary();
  const source = new DOMParser().parseFromString(await sanitizeInfographicSvg(diagram.svg), "image/svg+xml").documentElement;
  const exported = await library.exportToSVG(source as unknown as SVGSVGElement, { embedResources: false });
  const svg = new DOMParser().parseFromString(await sanitizeInfographicSvg(new XMLSerializer().serializeToString(exported)), "image/svg+xml").documentElement;
  const [,, width = 0, height = 0] = svg.getAttribute("viewBox")?.split(/[\s,]+/u).map(Number) ?? [];
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error("信息图尺寸无效");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  signal.throwIfAborted();
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      image.onload = null; image.onerror = null;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("信息图导出超时")), 10_000);
    image.onload = () => finish();
    image.onerror = () => finish(new Error("信息图无法导出"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  });
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, 8192 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (signal.aborted) reject(signal.reason);
    else if (blob) resolve(blob);
    else reject(new Error("信息图导出失败"));
  }, "image/png"));
}
