import { useCallback, useEffect, useRef, useState } from "react";
import { captureRegion, type CaptureRect, type CaptureScope, type CapturePrivacyRegion } from "../../../../windowCapture.js";
import { Icon } from "../Icon.js";
import { SettingsSwitch } from "../settings/SettingsSwitch.js";
import { captureBackgrounds, composeCapture } from "./captureCanvas.js";
import "./window-capture.css";

export function WindowCapture() {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const version = useRef(0);
  const inFlight = useRef(false);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<HTMLImageElement>();
  const [scope, setScope] = useState<CaptureScope>("window");
  const [privacyRegions, setPrivacyRegions] = useState<CapturePrivacyRegion[]>([]);
  const [privacy, setPrivacy] = useState(true);
  const [background, setBackground] = useState("mist");
  const [padding, setPadding] = useState(64);
  const [shadow, setShadow] = useState(true);
  const [mode, setMode] = useState<"crop" | "redact">("redact");
  const [crop, setCrop] = useState<CaptureRect>();
  const [regions, setRegions] = useState<CaptureRect[]>([]);
  const [draft, setDraft] = useState<CaptureRect>();
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const take = useCallback(async (nextScope: CaptureScope) => {
    if (inFlight.current || !window.binyCapture) return;
    inFlight.current = true;
    const current = ++version.current;
    dialog.current?.close(); setOpen(false); setBusy(true); setNotice(""); setFailed(false); setImage(undefined); setCrop(undefined); setDraft(undefined);
    try {
      const shot = await window.binyCapture.capture({ scope: nextScope, privacy: false });
      const decoded = new Image();
      await new Promise<void>((resolve, reject) => { decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error("截图读取失败")); decoded.src = shot.dataUrl; });
      if (version.current !== current) return;
      setPrivacyRegions(shot.privacyRegions);
      setImage(decoded); setCrop({ x: 0, y: 0, width: decoded.naturalWidth, height: decoded.naturalHeight }); setRegions([]);
    } catch (error) {
      if (version.current === current) { setFailed(true); setNotice(error instanceof Error ? error.message : "截图失败"); }
    } finally { inFlight.current = false; if (version.current === current) { setBusy(false); setOpen(true); } }
  }, []);
  useEffect(() => window.biny.onMenuAction(action => { if (action === "capture-window") void take(scope); }), [scope, take]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => () => { version.current++; }, []);
  useEffect(() => {
    if (!image || !crop || !preview.current) return;
    const composed = composeCapture(image, { crop, regions, padding, background, shadow, privacyRegions: privacy ? privacyRegions : [] });
    const target = preview.current;
    target.width = composed.width; target.height = composed.height;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(composed, 0, 0);
    if (draft) { ctx.strokeStyle = "#398cff"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(padding + draft.x - crop.x, padding + draft.y - crop.y, draft.width, draft.height); }
  }, [image, crop, regions, padding, background, shadow, draft, privacy, privacyRegions]);
  const close = () => { version.current++; setOpen(false); setImage(undefined); setBusy(false); setDraft(undefined); drag.current = undefined; };
  const exportImage = async (action: "copy" | "save") => {
    if (!image || !crop || !window.binyCapture || busy) return;
    const current = version.current;
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const data = composeCapture(image, { crop, regions, padding, background, shadow, privacyRegions: privacy ? privacyRegions : [] }).toDataURL("image/png");
      const path = await window.binyCapture[action](data);
      if (version.current === current && (action === "copy" || path)) setNotice(action === "copy" ? "已复制" : "已保存");
    } catch (error) { if (version.current === current) { setFailed(true); setNotice(error instanceof Error ? error.message : "导出失败"); } }
    finally { if (version.current === current) setBusy(false); }
  };
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(crop!.x, Math.min(crop!.x + crop!.width, (event.clientX - rect.left) * event.currentTarget.width / rect.width - padding + crop!.x)), y: Math.max(crop!.y, Math.min(crop!.y + crop!.height, (event.clientY - rect.top) * event.currentTarget.height / rect.height - padding + crop!.y)) };
  };
  const selection = (end: { x: number; y: number }): CaptureRect => ({ x: Math.min(drag.current!.x, end.x), y: Math.min(drag.current!.y, end.y), width: Math.abs(drag.current!.x - end.x), height: Math.abs(drag.current!.y - end.y) });
  if (!window.binyCapture) return null;
  return <dialog ref={dialog} data-window-capture className="window-capture-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header><Icon name="camera" size={16} /><h2>截取窗口</h2><button type="button" className="capture-icon-button" onClick={close} aria-label="关闭截图"><Icon name="close" size={16} /></button></header>
    <div className="window-capture-body">
      <div className="capture-workspace">
        <div className="capture-toolbar">
          <select aria-label="截取范围" disabled={busy} value={scope} onChange={event => { const value = event.target.value as CaptureScope; setScope(value); void take(value); }}><option value="window">整个窗口</option><option value="content">当前内容</option></select>
          <div className="capture-tools" role="group" aria-label="截图编辑">
            <button type="button" disabled={busy || !image} aria-pressed={mode === "crop"} onClick={() => setMode("crop")}>裁剪</button>
            <button type="button" disabled={busy || !image} aria-pressed={mode === "redact"} onClick={() => setMode("redact")}>打码</button>
            <button type="button" disabled={!regions.length || busy} onClick={() => setRegions(current => current.slice(0, -1))}>撤销打码</button>
            <button type="button" disabled={!image || busy} onClick={() => { setCrop({ x: 0, y: 0, width: image!.naturalWidth, height: image!.naturalHeight }); setRegions([]); setDraft(undefined); }}>重置</button>
          </div>
        </div>
      <div className="window-capture-preview" aria-busy={busy}>
        {image && crop ? <canvas ref={preview} aria-label="截图预览，拖拽框选区域" onPointerDown={event => { if (busy || event.button !== 0) return; drag.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); setDraft(undefined); }}
          onPointerMove={event => { if (drag.current) setDraft(selection(point(event))); }}
          onPointerUp={event => { if (!drag.current) return; const rect = selection(point(event)); drag.current = undefined; setDraft(undefined); if (rect.width < 4 || rect.height < 4) return; const region = captureRegion(rect, { width: image.naturalWidth, height: image.naturalHeight }); if (mode === "crop") setCrop(region); else setRegions(current => [...current, region]); }}
          onPointerCancel={() => { drag.current = undefined; setDraft(undefined); }} /> : <p>{busy ? "正在截取…" : "未取得截图"}</p>}
      </div>
      <p className="capture-hint">{mode === "crop" ? "拖拽框选要保留的区域" : "拖拽框选要打码的区域"}</p>
      </div>
      <aside>
        <fieldset className="capture-backgrounds"><legend>背景</legend><div>
          {captureBackgrounds.map(item => <button key={item.value} type="button" disabled={busy} aria-label={item.label} title={item.label} aria-pressed={background === item.value} className={`capture-swatch${item.value === "transparent" ? " is-transparent" : ""}`} style={{ background: "colors" in item ? `linear-gradient(135deg, ${item.colors.join(", ")})` : item.value }} onClick={() => setBackground(item.value)} />)}
        </div></fieldset>
        <label className="capture-padding">边距 <output>{padding}px</output><input aria-label="边距" type="range" min="0" max="120" step="8" disabled={busy} value={padding} onChange={event => setPadding(Number(event.target.value))} /></label>
        <SettingsSwitch checked={shadow} disabled={busy} label="阴影" onChange={setShadow} />
        <SettingsSwitch checked={privacy} disabled={busy} label="隐私" detail="对侧栏和顶部的会话标题打码" onChange={setPrivacy} />
      </aside>
    </div>
    <footer><button type="button" disabled={busy} onClick={() => void take(scope)}><Icon name="refresh" size={15} />重拍</button><span role={failed ? "alert" : "status"}>{notice}</span><button type="button" disabled={busy || !image} onClick={() => void exportImage("save")}><Icon name="download" size={15} />保存…</button><button type="button" className="capture-primary" disabled={busy || !image} onClick={() => void exportImage("copy")}><Icon name="copy" size={15} />复制</button></footer>
  </dialog>;
}
