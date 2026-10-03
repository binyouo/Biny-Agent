/** 工作区媒体使用本地流地址；播放器只在可见时存在，不自动恢复播放。 */
import React, { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Icon } from "../Icon.js";
import { readThemeColors } from "../../themeColors.js";
import { useMediaVisibility } from "./useMediaVisibility.js";
import { workspaceMediaKind, type WorkspaceMediaKind } from "./workspaceMediaType.js";

interface MediaSource { identity: string; url?: string; mimeType?: string; error?: string }

export function FileMediaPreview({ projectId, path, onOpenFile }: { projectId: string; path: string; onOpenFile(path: string): void }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const visible = useMediaVisibility(container);
  const kind = workspaceMediaKind(path);
  const [attempt, setAttempt] = useState(0);
  const identity = `${projectId}\n${path}\n${attempt}`;
  const [source, setSource] = useState<MediaSource>({ identity });
  const retry = () => setAttempt(value => value + 1);
  useEffect(() => {
    let current = true;
    if (!kind) return;
    void window.biny.getWorkspaceMediaUrl(projectId, path).then(result => {
      if (!current) return;
      const url = new URL(result.url);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || !result.mimeType.startsWith(`${kind}/`)) throw new Error("Unsupported media source");
      setSource({ identity, url: url.href, mimeType: result.mimeType });
    }).catch(() => { if (current) setSource({ identity, error: "媒体无法预览，请重试或使用系统应用打开" }); });
    return () => { current = false; };
  }, [projectId, path, kind, identity]);
  const ready = source.identity === identity && source.url && source.mimeType;
  return <div ref={container} className="file-media-preview">
    {!kind ? <MediaFeedback text="此媒体格式暂不支持预览" onOpen={() => onOpenFile(path)} />
      : source.identity === identity && source.error ? <MediaFeedback error text={source.error} onRetry={retry} onOpen={() => onOpenFile(path)} />
      : !ready ? <MediaFeedback text="正在读取媒体…" onOpen={() => onOpenFile(path)} />
      : !visible ? <MediaFeedback text="媒体预览已暂停" />
      : <MediaPlayback key={identity} url={source.url!} mimeType={source.mimeType!} kind={kind} onRetry={retry} onOpen={() => onOpenFile(path)} />}
  </div>;
}

function MediaFeedback({ text, error = false, onRetry, onOpen }: { text: string; error?: boolean; onRetry?(): void; onOpen?(): void }): React.JSX.Element {
  return <div className={`file-media-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
    <Icon name={error ? "warning" : "file"} size={20} /><span>{text}</span>
    <div>{onRetry ? <button type="button" aria-label="重试媒体预览" onClick={onRetry}>重试</button> : null}{onOpen ? <button type="button" aria-label="使用系统应用打开媒体" onClick={onOpen}>使用系统应用打开</button> : null}</div>
  </div>;
}

function MediaPlayback({ url, mimeType, kind, onRetry, onOpen }: { url: string; mimeType: string; kind: WorkspaceMediaKind; onRetry(): void; onOpen(): void }): React.JSX.Element {
  const media = useRef<HTMLMediaElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const visualization = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const playEpoch = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const connectAudio = useAudioSpectrum(media, canvas, visualization, kind === "audio" && playing);

  useEffect(() => {
    mounted.current = true;
    const element = media.current;
    element?.load();
    return () => {
      mounted.current = false;
      element?.pause();
      element?.removeAttribute("src");
      element?.querySelectorAll("source").forEach(source => source.removeAttribute("src"));
      element?.load();
    };
  }, [url]);

  const togglePlay = async () => {
    const element = media.current;
    if (!element || pending || error) return;
    if (!element.paused) { playEpoch.current++; element.pause(); setPlaying(false); return; }
    const epoch = ++playEpoch.current;
    setPending(true);
    try {
      const context = kind === "audio" ? connectAudio() : undefined;
      const resumed = context?.state === "suspended" ? context.resume() : undefined;
      await Promise.all([element.play(), resumed]);
      if (!mounted.current || epoch !== playEpoch.current) { element.pause(); return; }
      setPlaying(!element.paused); setLoading(false);
    } catch {
      element.pause();
      if (mounted.current && epoch === playEpoch.current) { setPlaying(false); setError("媒体播放失败，请重试或使用系统应用打开"); }
    } finally { if (mounted.current && epoch === playEpoch.current) setPending(false); }
  };
  const toggleMute = () => { const element = media.current; if (element) { element.muted = !element.muted; setMuted(element.muted); } };
  const metadata = () => {
    const element = media.current;
    if (!element) return;
    setDuration(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0);
    setReady(true); setLoading(false);
  };
  const fullscreen = async () => {
    setOperationError(undefined);
    try { await (media.current as HTMLVideoElement | null)?.requestFullscreen(); }
    catch { if (mounted.current) setOperationError("视频无法进入全屏，请重试"); }
  };
  const label = kind === "video" ? "视频" : "音频";
  const common = {
    ref: (element: HTMLMediaElement | null) => { media.current = element; }, preload: "metadata", crossOrigin: "anonymous" as const,
    onLoadedMetadata: metadata, onDurationChange: metadata,
    onTimeUpdate: () => { const value = media.current?.currentTime ?? 0; setTime(Number.isFinite(value) ? Math.max(0, value) : 0); },
    onPlay: () => { if (mounted.current) setPlaying(true); }, onPause: () => { if (mounted.current) setPlaying(false); },
    onEnded: () => { if (mounted.current) setPlaying(false); }, onWaiting: () => setLoading(true), onCanPlay: () => setLoading(false),
    onPlaying: () => setLoading(false), onVolumeChange: () => setMuted(media.current?.muted ?? false),
    onError: () => { media.current?.pause(); setPlaying(false); setLoading(false); setError("媒体加载失败，当前浏览器可能不支持此格式"); }
  };
  return <div className={`file-media-player is-${kind}`}>
    <div className="file-media-stage" ref={visualization}>
      {kind === "video" ? <video {...common} playsInline aria-label="视频预览"><source src={url} type={mimeType} /></video>
        : <><canvas ref={canvas} className="file-media-spectrum" aria-hidden="true" /><button className="file-media-central-play" type="button" aria-label={`${playing ? "暂停" : "播放"}音频`} disabled={!ready || pending || !!error} onClick={() => void togglePlay()}><Icon name={playing ? "pause" : "play"} size={28} /></button><audio {...common} aria-label="音频预览"><source src={url} type={mimeType} /></audio></>}
      {loading && !error ? <span className="file-media-loading" role="status">正在加载{label}…</span> : null}
    </div>
    <div className="file-media-controls" role="group" aria-label={`${label}播放控制`}>
      <button type="button" aria-label={`${playing ? "暂停" : "播放"}${label}`} disabled={!ready || pending || !!error} onClick={() => void togglePlay()}><Icon name={playing ? "pause" : "play"} size={16} /></button>
      <span className="file-media-time">{formatMediaTime(time)}</span>
      <input type="range" aria-label="播放进度" min={0} max={duration || 100} step={0.1} value={Math.min(time, duration || time)} disabled={!ready || !duration || !!error} onInput={event => {
        const value = Math.min(duration, Math.max(0, Number(event.currentTarget.value)));
        if (media.current && Number.isFinite(value)) { media.current.currentTime = value; setTime(value); }
      }} />
      <span className="file-media-time">{formatMediaTime(duration)}</span>
      <button type="button" aria-label={muted ? "取消静音" : "静音"} onClick={toggleMute}><Icon name={muted ? "volume-off" : "volume"} size={16} /></button>
      {kind === "video" ? <button type="button" aria-label="全屏播放视频" disabled={typeof document.documentElement.requestFullscreen !== "function"} onClick={() => void fullscreen()}><Icon name="expand" size={16} /></button> : null}
    </div>
    {operationError ? <div role="alert" className="file-media-operation-error">{operationError}</div> : null}
    {error ? <MediaFeedback error text={error} onRetry={onRetry} onOpen={onOpen} /> : null}
  </div>;
}

function formatMediaTime(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface AudioGraph { context: AudioContext; analyser: AnalyserNode; source: MediaElementAudioSourceNode }

function useAudioSpectrum(media: React.RefObject<HTMLMediaElement | null>, canvas: React.RefObject<HTMLCanvasElement | null>, container: React.RefObject<HTMLDivElement | null>, playing: boolean): () => AudioContext {
  const graph = useRef<AudioGraph | undefined>(undefined);
  const dimensions = useRef({ width: 0, height: 0 });
  const frame = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [themeRevision, setThemeRevision] = useState(0);
  const palette = useRef<{ revision: number; active: string; dim: string; idle: string } | undefined>(undefined);
  const stopFrame = useCallback(() => { if (frame.current !== undefined) window.cancelAnimationFrame(frame.current); frame.current = undefined; }, []);
  const draw = useEffectEvent((active: boolean) => {
    const element = canvas.current;
    const parent = container.current;
    if (!element || !parent) return;
    const context = element.getContext("2d");
    if (!context) return;
    const { width, height } = dimensions.current;
    if (element.width !== width || element.height !== height) { element.setAttribute("width", String(width)); element.setAttribute("height", String(height)); }
    context.clearRect(0, 0, width, height);
    if (palette.current?.revision !== themeRevision) {
      const primary = readThemeColors(parent, { primary: "--green" }).primary;
      const channels = /^#([a-f\d]{6})$/iu.exec(primary)?.[1];
      const alpha = (value: number) => channels ? `rgba(${[0, 2, 4].map(offset => parseInt(channels.slice(offset, offset + 2), 16)).join(",")},${value})` : primary;
      palette.current = { revision: themeRevision, active: alpha(.8), dim: alpha(.3), idle: alpha(.2) };
    }
    const colors = palette.current;
    const analyser = graph.current?.analyser;
    const values = new Uint8Array(analyser?.frequencyBinCount ?? 128);
    if (active && analyser) analyser.getByteFrequencyData(values);
    const barWidth = Math.max(1, width / 64 - 2);
    for (let index = 0; index < 64; index++) {
      const value = values[Math.floor(index / 64 * values.length)]! / 255;
      const barHeight = active ? Math.max(4, value * height * .8) : 4 + (Math.sin(index / 64 * Math.PI * 4) * .5 + .5) * 20;
      const x = index * (barWidth + 2) + 2;
      const y = (height - barHeight) / 2;
      if (active) {
        const gradient = context.createLinearGradient(x, y, x, y + barHeight);
        gradient.addColorStop(0, colors.active); gradient.addColorStop(.5, colors.active); gradient.addColorStop(1, colors.dim);
        context.fillStyle = gradient;
      } else context.fillStyle = colors.idle;
      context.beginPath(); context.roundRect(x, y, barWidth, barHeight, 2); context.fill();
    }
  });
  const resize = useEffectEvent(() => {
    const parent = container.current;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    dimensions.current = { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    draw(playing && ready && !reducedMotion);
  });
  useEffect(() => {
    const parent = container.current;
    if (!canvas.current || !parent) return;
    const observer = new ResizeObserver(() => resize());
    observer.observe(parent); resize();
    return () => observer.disconnect();
  }, [canvas, container]);
  useEffect(() => {
    if (!canvas.current) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    const theme = new MutationObserver(() => setThemeRevision(value => value + 1));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-base46-theme"] });
    preference.addEventListener("change", update);
    return () => { theme.disconnect(); preference.removeEventListener("change", update); };
  }, [canvas]);
  useEffect(() => {
    stopFrame();
    if (playing && ready && !reducedMotion) {
      const animate = () => { draw(true); frame.current = window.requestAnimationFrame(animate); };
      animate();
    } else { draw(false); if (!playing && graph.current?.context.state === "running") void graph.current.context.suspend().catch(() => undefined); }
    return stopFrame;
  }, [playing, ready, reducedMotion, stopFrame, themeRevision]);
  useEffect(() => () => {
    stopFrame();
    const current = graph.current;
    graph.current = undefined;
    current?.source.disconnect(); current?.analyser.disconnect();
    if (current && current.context.state !== "closed") void current.context.close().catch(() => undefined);
  }, [stopFrame]);
  return () => {
    if (graph.current) return graph.current.context;
    const element = media.current;
    if (!element) throw new Error("Audio element unavailable");
    const context = new AudioContext();
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = .8;
      const source = context.createMediaElementSource(element);
      source.connect(analyser); analyser.connect(context.destination);
      graph.current = { context, analyser, source }; setReady(true);
      return context;
    } catch (error) { void context.close().catch(() => undefined); throw error; }
  };
}
