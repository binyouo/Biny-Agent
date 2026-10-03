export const PATTERN_PLAYER_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src data: blob:; worker-src data: blob:; form-action 'none'; base-uri 'none'; object-src 'none'";

export type PatternPlayerState = "ready" | "loading" | "playing" | "stopped" | "error";
export interface PatternPlayerStatus { kind: "pattern-state"; token: string; state: PatternPlayerState; message?: string }

export function readPatternPlayerStatus(data: unknown, token: string): PatternPlayerStatus | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const status = data as Record<string, unknown>;
  if (Object.keys(status).some(key => !["kind", "token", "state", "message"].includes(key))
    || status.kind !== "pattern-state" || status.token !== token
    || typeof status.state !== "string" || !["ready", "loading", "playing", "stopped", "error"].includes(status.state)
    || (status.message !== undefined && (typeof status.message !== "string" || status.message.length > 512))) return;
  return status as unknown as PatternPlayerStatus;
}

export function createPatternPlayerDocument({ engineSource, playerSource, css, token }: {
  engineSource: string; playerSource: string; css: string; token: string;
}): string {
  const script = (source: string): string => source.replace(/<\/script/giu, "<\\/script");
  const styles = css.replace(/<\/style/giu, "<\\/style");
  const configuration = JSON.stringify(token).replace(/</gu, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PATTERN_PLAYER_CSP}"><meta name="referrer" content="no-referrer"><style>${styles}</style></head><body class="pattern-player"><button type="button" aria-label="播放音乐" title="播放音乐" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path id="play-icon" d="m8 5 11 7-11 7z"/></svg></button><canvas aria-label="音乐频谱"></canvas><span class="pattern-player-error" role="alert" hidden></span><script>window.__patternPlayerToken=${configuration};</script><script>${script(engineSource)}</script><script>${script(playerSource)}</script></body></html>`;
}
