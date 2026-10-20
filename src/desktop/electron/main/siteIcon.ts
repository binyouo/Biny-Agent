import sharp from "sharp";
import { assertFetchableUrl, type HostnameResolver } from "../../../tools/web/addressPolicy.js";

const maxHtmlBytes = 1 * 1024 * 1024;
const maxIconBytes = 512 * 1024;
const maxRedirects = 5;
const timeoutMs = 8_000;

interface IconCandidate {
  url: string;
  size: number;
  svg: boolean;
}

export interface SiteIconDependencies {
  fetcher?: typeof fetch;
  resolveHostname?: HostnameResolver;
}

/** 从用户输入的网站地址读取 favicon，输出尺寸受限的 PNG data URL。 */
export async function fetchSiteIconDataUrl(input: string, dependencies: SiteIconDependencies = {}): Promise<string | undefined> {
  const pageUrl = normalizeSiteUrl(input);
  if (!pageUrl) return undefined;
  const fetcher = dependencies.fetcher ?? fetch;
  const signal = AbortSignal.timeout(15_000);
  const allowPrivateNetwork = pageUrl.hostname === "localhost" || pageUrl.hostname.endsWith(".localhost");
  const request = (url: URL, byteLimit: number): Promise<{ url: URL; contentType: string; bytes: Buffer } | undefined> =>
    fetchBounded(url, byteLimit, fetcher, signal, allowPrivateNetwork, dependencies.resolveHostname);

  const page = await request(pageUrl, maxHtmlBytes);
  const finalPageUrl = page?.url ?? pageUrl;
  const candidates: IconCandidate[] = [];
  let manifestUrl: URL | undefined;
  if (page?.contentType.includes("html")) {
    const parsed = parseHtmlIconCandidates(page.bytes.toString("utf8"), finalPageUrl);
    candidates.push(...parsed.icons);
    manifestUrl = parsed.manifest;
  }
  if (manifestUrl) {
    const manifest = await request(manifestUrl, maxHtmlBytes);
    if (manifest) candidates.push(...parseManifestIconCandidates(manifest.bytes.toString("utf8"), manifest.url));
  }
  candidates.push({ url: new URL("/favicon.ico", finalPageUrl.origin).href, size: 0, svg: false });
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url));
  unique.sort((left, right) => iconRank(right) - iconRank(left));

  let smallest: string | undefined;
  for (const candidate of unique.slice(0, 6)) {
    const icon = await request(new URL(candidate.url), maxIconBytes);
    const dataUrl = await toPngDataUrl(icon?.bytes);
    if (!dataUrl) continue;
    if (candidate.size >= 32 || candidate.svg) return dataUrl;
    smallest ??= dataUrl;
  }

  const fallback = await request(new URL(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(finalPageUrl.hostname)}&sz=128`), maxIconBytes);
  return await toPngDataUrl(fallback?.bytes) ?? smallest;
}

export function normalizeSiteUrl(input: string): URL | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

async function fetchBounded(
  initialUrl: URL,
  maxBytes: number,
  fetcher: typeof fetch,
  signal: AbortSignal,
  allowPrivateNetwork: boolean,
  resolveHostname?: HostnameResolver
): Promise<{ url: URL; contentType: string; bytes: Buffer } | undefined> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    await assertFetchableUrl(url, { allowPrivateNetwork, resolveHostname });
    signal.throwIfAborted();
    const response = await fetcher(url, {
      redirect: "manual",
      headers: { accept: "text/html,application/manifest+json,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.5", "user-agent": "Biny/ProjectIcon" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === maxRedirects) return undefined;
      url = new URL(location, url);
      if (url.username || url.password) return undefined;
      continue;
    }
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) return undefined;
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return { url, contentType, bytes: Buffer.concat(chunks) };
  }
  return undefined;
}

function parseHtmlIconCandidates(html: string, baseUrl: URL): { icons: IconCandidate[]; manifest?: URL } {
  const icons: IconCandidate[] = [];
  let manifest: URL | undefined;
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const rel = (htmlAttribute(tag, "rel") ?? "").toLowerCase().split(/\s+/u);
    const href = htmlAttribute(tag, "href");
    if (!href) continue;
    const resolved = resolveAssetUrl(href, baseUrl);
    if (!resolved) continue;
    if (rel.includes("manifest")) {
      manifest ??= resolved;
      continue;
    }
    if (rel.includes("mask-icon")) continue;
    const apple = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!apple && !rel.includes("icon")) continue;
    icons.push({
      url: resolved.href,
      size: parseIconSize(htmlAttribute(tag, "sizes")) || (apple ? 180 : 0),
      svg: (htmlAttribute(tag, "type") ?? "").includes("svg") || /\.svg(?:$|\?)/iu.test(resolved.href)
    });
  }
  return { icons, manifest };
}

function parseManifestIconCandidates(text: string, baseUrl: URL): IconCandidate[] {
  try {
    const manifest = JSON.parse(text) as { icons?: unknown };
    if (!Array.isArray(manifest.icons)) return [];
    return manifest.icons.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const icon = raw as { src?: unknown; sizes?: unknown; type?: unknown; purpose?: unknown };
      if (typeof icon.src !== "string" || typeof icon.purpose === "string" && !icon.purpose.split(/\s+/u).includes("any")) return [];
      const url = resolveAssetUrl(icon.src, baseUrl);
      if (!url) return [];
      return [{
        url: url.href,
        size: parseIconSize(typeof icon.sizes === "string" ? icon.sizes : undefined),
        svg: typeof icon.type === "string" && icon.type.includes("svg") || /\.svg(?:$|\?)/iu.test(url.href)
      }];
    });
  } catch {
    return [];
  }
}

async function toPngDataUrl(bytes: Buffer | undefined): Promise<string | undefined> {
  if (!bytes?.length) return undefined;
  try {
    const png = await sharp(bytes, { failOn: "none", limitInputPixels: 1_000_000 })
      .resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function resolveAssetUrl(value: string, baseUrl: URL): URL | undefined {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function parseIconSize(value: string | undefined): number {
  const match = value?.match(/(?:^|\s)(\d+)x\d+/iu);
  const size = Number(match?.[1]);
  return Number.isFinite(size) ? size : 0;
}

function iconRank(candidate: IconCandidate): number {
  return candidate.svg ? 64 : candidate.size;
}
