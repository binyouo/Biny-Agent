import { useCallback, useEffect, useRef, useState } from "react";
import { captureRegion, type CaptureRect, type CaptureScope, type CapturePrivacyRegion } from "../../../../windowCapture.js";
import { Icon, type IconName } from "../Icon.js";
import { SettingsSwitch } from "../settings/SettingsSwitch.js";
import { captureBackgrounds, composeCapture, loadCaptureImage } from "./captureCanvas.js";
import "./window-capture.css";

type Edit = { crop: CaptureRect; regions: CaptureRect[] };
type Drag = { kind: "pan"; x: number; y: number; panX: number; panY: number } | { kind: "selection"; x: number; y: number };

function CaptureTool({ label, icon, onClick, disabled, pressed }: { label: string; icon: IconName; onClick(): void; disabled: boolean; pressed?: boolean }) {
  return <button type="button" className="capture-icon-button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={16} /></button>;
}

export function WindowCapture() {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const backgroundVersion = useRef(0);
  const inFlight = useRef(false);
  const exporting = useRef(false);
  const drag = useRef<Drag | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<HTMLImageElement>();
  const [scope, setScope] = useState<CaptureScope>("window");
  const [privacyRegions, setPrivacyRegions] = useState<CapturePrivacyRegion[]>([]);
  const [maskTitles, setMaskTitles] = useState(true);
  const [maskAccounts, setMaskAccounts] = useState(true);
  const [background, setBackground] = useState<{ value: string; image?: HTMLImageElement }>({ value: "sea" });
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [padding, setPadding] = useState(64);
  const [shadow, setShadow] = useState(true);
  const [mode, setMode] = useState<"pan" | "crop" | "redact">("pan");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [history, setHistory] = useState<{ stack: Edit[]; index: number }>({ stack: [], index: 0 });
  const edit = history.stack[history.index];
  const crop = edit?.crop;
  const regions = edit?.regions;
  const [draft, setDraft] = useState<CaptureRect>();
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const clearDrag = () => { drag.current = undefined; setDraft(undefined); setPanning(false); };
  const changeHistory = (delta: number) => {
    clearDrag();
    setHistory(current => ({ ...current, index: Math.max(0, Math.min(current.stack.length - 1, current.index + delta)) }));
  };
  const pushEdit = (next: Edit) => {
    setHistory(current => {
      const stack = [...current.stack.slice(0, current.index + 1), next].slice(-50);
      return { stack, index: stack.length - 1 };
    });
  };
  const take = useCallback(async (nextScope: CaptureScope) => {
    if (inFlight.current || exporting.current || !window.binyCapture) return;
    inFlight.current = true;
    const current = ++version.current;
    dialog.current?.close(); setOpen(false); setBusy(true); setNotice(""); setFailed(false); setImage(undefined); setDraft(undefined);
    drag.current = undefined; setPanning(false);
    try {
      const preset = captureBackgrounds.find(item => item.value === background.value);
      const [captureResult, backgroundResult] = await Promise.allSettled([
        window.binyCapture.capture({ scope: nextScope, privacy: false }),
        !background.image && preset && "src" in preset ? loadCaptureImage(preset.src) : undefined
      ]);
      if (captureResult.status === "rejected") throw captureResult.reason;
      if (backgroundResult.status === "rejected") throw backgroundResult.reason;
      const shot = captureResult.value;
      const initialBackground = backgroundResult.value;
      const decoded = await loadCaptureImage(shot.dataUrl);
      if (version.current !== current) return;
      if (initialBackground) setBackground({ value: background.value, image: initialBackground });
      setPrivacyRegions(shot.privacyRegions);
      setImage(decoded);
      setHistory({ stack: [{ crop: { x: 0, y: 0, width: decoded.naturalWidth, height: decoded.naturalHeight }, regions: [] }], index: 0 });
      setZoom(1); setPan({ x: 0, y: 0 }); setMode("pan");
    } catch (error) {
      if (version.current === current) { setFailed(true); setNotice(error instanceof Error ? error.message : "截图失败"); }
    } finally { inFlight.current = false; if (version.current === current) { setBusy(false); setOpen(true); } }
  }, [background]);
  useEffect(() => window.biny.onMenuAction(action => { if (action === "capture-window" && !dialog.current?.open) void take(scope); }), [scope, take]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => () => { version.current++; backgroundVersion.current++; }, []);
  const hasTitles = privacyRegions.some(region => region.kind === "title");
  const hasAccounts = privacyRegions.some(region => region.kind === "account");
  const activePrivacy = privacyRegions.filter(region => region.kind === "title" ? maskTitles : maskAccounts);
  const composition = { crop: crop!, regions: regions ?? [], padding, background: background.value, backgroundImage: background.image, shadow, privacyRegions: activePrivacy };
  useEffect(() => {
    if (!image || !crop || !preview.current) return;
    const composed = composeCapture(image, { crop, regions: regions ?? [], padding, background: background.value, backgroundImage: background.image, shadow, privacyRegions: activePrivacy });
    const target = preview.current;
    target.width = composed.width; target.height = composed.height;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(composed, 0, 0);
    if (draft) { ctx.strokeStyle = "#398cff"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(padding + draft.x - crop.x, padding + draft.y - crop.y, draft.width, draft.height); }
  }, [image, crop, regions, padding, background, shadow, draft, maskTitles, maskAccounts, privacyRegions]);
  useEffect(() => {
    const target = frame.current;
    if (!open || !target) return;
    const wheel = (event: WheelEvent) => {
      if (!image || busy) return;
      event.preventDefault();
      setZoom(current => Math.max(.25, Math.min(4, current * Math.exp(-event.deltaY * .002))));
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [open, image, busy]);
  const close = () => { version.current++; backgroundVersion.current++; setOpen(false); setImage(undefined); setBusy(false); setBackgroundBusy(false); clearDrag(); };
  const chooseBackground = async (value: string, source?: string) => {
    const current = ++backgroundVersion.current;
    setNotice(""); setFailed(false); setBackgroundBusy(Boolean(source));
    try {
      const decoded = source ? await loadCaptureImage(source) : undefined;
      if (backgroundVersion.current === current) setBackground({ value, image: decoded });
    } catch (error) {
      if (backgroundVersion.current === current) { setFailed(true); setNotice(error instanceof Error ? error.message : "背景读取失败"); }
    } finally { if (backgroundVersion.current === current) setBackgroundBusy(false); }
  };
  const exportImage = async (action: "copy" | "save") => {
    if (!image || !crop || !window.binyCapture || busy || backgroundBusy || exporting.current) return;
    const current = version.current;
    exporting.current = true; setBusy(true); setNotice(""); setFailed(false); clearDrag();
    try {
      const data = composeCapture(image, composition).toDataURL("image/png");
      const path = await window.binyCapture[action](data);
      if (version.current === current && (action === "copy" || path)) setNotice(action === "copy" ? "已复制" : "已保存");
    } catch (error) { if (version.current === current) { setFailed(true); setNotice(error instanceof Error ? error.message : "导出失败"); } }
    finally { exporting.current = false; if (version.current === current) setBusy(false); }
  };
  const point = (event: React.PointerEvent) => {
    const rect = preview.current!.getBoundingClientRect();
    return { x: Math.max(crop!.x, Math.min(crop!.x + crop!.width, (event.clientX - rect.left) * preview.current!.width / rect.width - padding + crop!.x)), y: Math.max(crop!.y, Math.min(crop!.y + crop!.height, (event.clientY - rect.top) * preview.current!.height / rect.height - padding + crop!.y)) };
  };
  const selection = (start: { x: number; y: number }, end: { x: number; y: number }): CaptureRect => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) });

  if (!window.binyCapture) return null;
  return <dialog ref={dialog} data-window-capture className="window-capture-dialog" aria-labelledby="window-capture-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
    if (!(event.metaKey || event.ctrlKey) || (event.target as HTMLElement).tagName === "INPUT") return;
    const key = event.key.toLowerCase();
    if (!["z", "y", "c", "s"].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (busy || backgroundBusy) return;
    if (key === "z" || key === "y") changeHistory(key === "y" || event.shiftKey ? 1 : -1);
    else void exportImage(key === "c" ? "copy" : "save");
  }}>
    <header><Icon name="camera" size={16} /><h2 id="window-capture-title">截取窗口</h2><button type="button" className="capture-icon-button" onClick={close} aria-label="关闭截图"><Icon name="close" size={16} /></button></header>
    <div className="window-capture-body">
      <div className="capture-workspace">
        <div className="capture-toolbar">
          <select aria-label="截取范围" disabled={busy} value={scope} onChange={event => { const value = event.target.value as CaptureScope; setScope(value); void take(value); }}><option value="window">整个窗口</option><option value="content">当前内容</option></select>
          <div className="capture-tools" role="group" aria-label="截图编辑">
            <CaptureTool label="拖动" icon="hand" onClick={() => { clearDrag(); setMode("pan"); }} disabled={busy || !image} pressed={mode === "pan"} />
            <CaptureTool label="打码" icon="inspect" onClick={() => { clearDrag(); setMode("redact"); }} disabled={busy || !image} pressed={mode === "redact"} />
            <CaptureTool label="裁剪" icon="crop" onClick={() => { clearDrag(); setMode("crop"); }} disabled={busy || !image} pressed={mode === "crop"} />
            <span className="capture-tool-divider" />
            <CaptureTool label="撤销" icon="undo" onClick={() => changeHistory(-1)} disabled={busy || !image || history.index <= 0} />
            <CaptureTool label="重做" icon="redo" onClick={() => changeHistory(1)} disabled={busy || !image || history.index >= history.stack.length - 1} />
            <span className="capture-tool-divider" />
            <CaptureTool label="缩小" icon="zoom-out" onClick={() => setZoom(current => Math.max(.25, current / 1.25))} disabled={busy || !image || zoom <= .25} />
            <button type="button" className="capture-zoom" disabled={busy || !image} aria-label="重置视图" title="重置视图" onClick={resetView}>{Math.round(zoom * 100)}%</button>
            <CaptureTool label="放大" icon="zoom-in" onClick={() => setZoom(current => Math.min(4, current * 1.25))} disabled={busy || !image || zoom >= 4} />
            <CaptureTool label="适应窗口" icon="expand" onClick={resetView} disabled={busy || !image} />
          </div>
        </div>
        <div ref={frame} className={`window-capture-preview is-${mode}${panning ? " is-panning" : ""}`} aria-busy={busy} onPointerDown={event => {
          if (busy || !image || !crop || (event.button !== 0 && event.button !== 1)) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (mode === "pan" || event.button === 1) { drag.current = { kind: "pan", x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; setPanning(true); }
          else { drag.current = { kind: "selection", ...point(event) }; setDraft(undefined); }
        }} onPointerMove={event => {
          const start = drag.current;
          if (!start) return;
          if (start.kind === "pan") setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
          else setDraft(selection(start, point(event)));
        }} onPointerUp={event => {
          const start = drag.current;
          clearDrag();
          if (!start || start.kind !== "selection" || !image || !edit) return;
          const rect = selection(start, point(event));
          if (rect.width < 4 || rect.height < 4) return;
          const region = captureRegion(rect, { width: image.naturalWidth, height: image.naturalHeight });
          pushEdit(mode === "crop" ? { ...edit, crop: region } : { ...edit, regions: [...edit.regions, region] });
          if (mode === "crop") resetView();
        }} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}>
          {image && crop ? <canvas ref={preview} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} aria-label="截图预览，支持拖动、缩放及区域编辑" /> : <p>{busy ? "正在截取…" : "未取得截图"}</p>}
        </div>
        {mode !== "pan" && <p className="capture-hint">{mode === "crop" ? "拖拽框选要保留的区域" : "拖拽框选要打码的区域"}</p>}
      </div>
      <aside>
        <fieldset className="capture-backgrounds"><legend>背景</legend><div>
          {captureBackgrounds.map(item => <button key={item.value} type="button" disabled={busy} aria-label={item.label} title={item.label} aria-pressed={background.value === item.value} className="capture-swatch" style={{ background: "src" in item ? `url(${item.src}) center / cover` : `linear-gradient(135deg, ${item.colors.join(", ")})` }} onClick={() => void chooseBackground(item.value, "src" in item ? item.src : undefined)} />)}
          <label className={`capture-swatch capture-color${background.value.startsWith("#") ? " is-selected" : ""}`} title="自定义颜色" style={{ background: background.value.startsWith("#") ? background.value : undefined }}><Icon name="edit" size={14} /><input aria-label="自定义颜色" type="color" value={background.value.startsWith("#") ? background.value : "#e4e8ef"} disabled={busy} onChange={event => void chooseBackground(event.target.value)} /></label>
          <button type="button" disabled={busy} aria-label="透明背景" title="透明背景" aria-pressed={background.value === "transparent"} className="capture-swatch is-transparent" onClick={() => void chooseBackground("transparent")} />
          <button type="button" disabled={busy} aria-label="选择背景图片" title="选择背景图片" aria-pressed={background.value === "custom"} className="capture-swatch capture-upload" onClick={() => upload.current?.click()}><Icon name="image" size={14} /></button>
        </div></fieldset>
        <input ref={upload} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="背景图片文件" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          if (file.size > 20 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setFailed(true); setNotice("请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片"); return; }
          const url = URL.createObjectURL(file);
          void chooseBackground("custom", url).finally(() => URL.revokeObjectURL(url));
        }} />
        <label className="capture-padding">边距 <output>{padding}px</output><input aria-label="边距" type="range" min="0" max="160" step="8" disabled={busy} value={padding} onChange={event => { clearDrag(); setPadding(Number(event.target.value)); resetView(); }} /></label>
        <fieldset className="capture-display"><legend>显示</legend>
          <SettingsSwitch checked={shadow} disabled={busy} label="阴影" onChange={setShadow} />
        </fieldset>
        <fieldset className="capture-display"><legend>隐私</legend>
          {!hasTitles && !hasAccounts ? <p className="capture-empty">画面中没有可遮盖的隐私内容</p> : <>
            {hasTitles ? <SettingsSwitch checked={maskTitles} disabled={busy} label="会话标题" detail="侧栏与顶部标题模糊" onChange={setMaskTitles} /> : null}
            {hasAccounts ? <SettingsSwitch checked={maskAccounts} disabled={busy} label="账号" detail="邮箱与账号名模糊" onChange={setMaskAccounts} /> : null}
          </>}
        </fieldset>
      </aside>
    </div>
    <footer><button type="button" className="capture-retake" disabled={busy} onClick={() => void take(scope)}><Icon name="refresh" size={15} />重拍</button><span role={failed ? "alert" : "status"}>{backgroundBusy ? "正在读取背景…" : notice}</span><button type="button" disabled={busy || backgroundBusy || !image} onClick={() => void exportImage("save")}><Icon name="download" size={15} />保存…</button><button type="button" className="capture-primary" disabled={busy || backgroundBusy || !image} onClick={() => void exportImage("copy")}><Icon name="copy" size={15} />复制</button></footer>
  </dialog>;
}
