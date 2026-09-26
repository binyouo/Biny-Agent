/** 结晶的桌面工作区：观察位、收纳与正式对象共用核心生命周期，确认后可插入聊天引用。 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { Crystal, CrystalType } from "../../../../agent/context/crystalTypes.js";
import type { DesktopCrystalRequest, DesktopCrystalSnapshot } from "../../../crystalProtocol.js";
import { Icon } from "./Icon.js";
import "../styles/crystal.css";

const typeLabels: Record<CrystalType, string> = { entity: "实体", concept: "概念", claim: "论点", process: "流程", rule: "规则", project: "项目" };
const fieldLabels: Record<string, string> = {
  identity: "身份", time: "时间", participants: "参与者", source: "来源", status: "状态",
  definition: "定义", includes: "包含范围", excludes: "排除范围", examples: "例子",
  statement: "论点", scope: "适用范围", supporting: "支持依据", opposing: "反对依据",
  trigger: "触发条件", inputs: "输入", steps: "步骤", outputs: "输出", failure_handling: "失败处理", permissions: "权限",
  subjects: "适用对象", conditions: "条件", forbidden_allowed: "允许与禁止", exceptions: "例外", stop_conditions: "停止条件",
  goal: "目标", deliverables: "交付物", version: "版本", rights_status: "权利与授权"
};

export function CrystalDock({ sessionId, onInsert }: { sessionId?: string; onInsert(reference: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DesktopCrystalSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [attachThread, setAttachThread] = useState(false);
  const operation = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    setError(undefined);
    void window.biny.crystalRequest({ action: "overview" }).then((result) => {
      if (current === generation.current) setSnapshot(result);
    }).catch((reason: unknown) => {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "结晶加载失败。");
    });
    return () => { generation.current += 1; };
  }, [open]);

  const request = async (input: DesktopCrystalRequest): Promise<boolean> => {
    if (operation.current) return false;
    operation.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.biny.crystalRequest(input);
      if (current === generation.current) setSnapshot(result);
      return true;
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
      return false;
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const row = (crystal: Crystal): React.JSX.Element => (
    <button className={`crystal-list-row${snapshot?.detail?.crystal.id === crystal.id ? " is-selected" : ""}`} disabled={busy}
      key={crystal.id} onClick={() => { void request({ action: "detail", id: crystal.id }); }} type="button">
      <Icon name="cube" size={15} /><span>{crystal.name}</span>
      {crystal.dormant ? <small>休眠</small> : crystal.notified && crystal.stage === "candidate" ? <small>可确认</small> : null}
    </button>
  );
  return <>
    <Tooltip content="结晶" delay={150} placement="above">
      <button aria-label="结晶" aria-haspopup="dialog" className="biny-chrome-button biny-sidebar-crystal-button" onClick={() => setOpen(true)} type="button">
        <Icon name="cube" size={16} />
      </button>
    </Tooltip>
    <Dialog isOpen={open} onOpenChange={setOpen} padding={0} width={880} purpose="form">
      <div className="crystal-window">
        <div className="crystal-window-title"><DialogHeader onOpenChange={setOpen} title="结晶" /></div>
        {error ? <p className="crystal-error" role="alert">{error}</p> : null}
        <div className="crystal-layout" aria-busy={busy}>
          <aside className="crystal-library" aria-label="结晶列表">
            <div className="crystal-section-heading"><h3>正在观察 <small>{snapshot?.overview.slots.length ?? 0} / 3</small></h3>
              <button className="icon-button" aria-label="刷新结晶" disabled={busy} onClick={() => { void request({ action: "overview" }); }} type="button"><Icon name="refresh" size={14} /></button>
            </div>
            {[1, 2, 3].map((slot) => {
              const crystal = snapshot?.overview.slots.find((entry) => entry.slot === slot);
              return crystal ? row(crystal) : <div className="crystal-empty-slot" key={slot}>观察位 {slot}</div>;
            })}
            <form className="crystal-seed-form" onSubmit={(event) => {
              event.preventDefault();
              void request({ action: "seed", name: name.trim(), sessionId: attachThread ? sessionId : undefined }).then((ok) => { if (ok) setName(""); });
            }}>
              <label htmlFor="crystal-seed-name">想持续了解什么？</label>
              <input id="crystal-seed-name" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="一个项目、概念或问题" value={name} />
              {sessionId ? <label className="crystal-checkbox"><input checked={attachThread} onChange={(event) => setAttachThread(event.target.checked)} type="checkbox" />附上当前会话的材料</label> : null}
              <button disabled={busy || !name.trim() || (snapshot?.overview.slots.length ?? 3) >= 3} type="submit">开始观察</button>
            </form>
            {(snapshot?.overview.contourCount ?? 0) > 0 ? <p className="crystal-muted">还有 {snapshot?.overview.contourCount} 个反复提及的主题正在形成轮廓。</p> : null}
            <h3>收纳区 <small>{snapshot?.overview.backpack.length ?? 0}</small></h3>
            {snapshot?.overview.backpack.length ? snapshot.overview.backpack.map(row) : <p className="crystal-muted">收起的观察与自然形成的候选会留在这里。</p>}
            <h3>正式结晶 <small>{snapshot?.overview.formal.length ?? 0}</small></h3>
            {snapshot?.overview.formal.length ? snapshot.overview.formal.map(row) : <p className="crystal-muted">确认后的结晶可以在聊天中引用。</p>}
          </aside>
          {snapshot?.detail ? <CrystalDetailPane busy={busy} detail={snapshot.detail} key={`${snapshot.detail.crystal.id}:${snapshot.detail.crystal.updatedAt}`}
            freeSlot={[1, 2, 3].find((slot) => !snapshot.overview.slots.some((entry) => entry.slot === slot))}
            onInsert={() => { onInsert(`@[${snapshot.detail!.crystal.name.replace(/[[\]\r\n]/gu, " ")}](biny://crystal/${snapshot.detail!.crystal.id})`); setOpen(false); }} onRequest={request} />
            : <div className="crystal-welcome"><Icon name="cube" size={36} /><h2>让值得留下的内容慢慢成形</h2>
              <p>为关心的主题开启观察，或从自然形成的候选中挑选。材料积累后，补全清单并确认成正式结晶。</p>
              <p>结晶是有来源的参考内容。你决定何时确认、何时引用。</p>
              {!snapshot ? <p role="status">正在读取…</p> : null}</div>}
        </div>
      </div>
    </Dialog>
  </>;
}

function CrystalDetailPane({ detail, busy, freeSlot, onRequest, onInsert }: {
  detail: NonNullable<DesktopCrystalSnapshot["detail"]>; busy: boolean; freeSlot?: number;
  onRequest(request: DesktopCrystalRequest): Promise<boolean>; onInsert(): void;
}): React.JSX.Element {
  const { crystal, checklistSpec, validation } = detail;
  const [fields, setFields] = useState(() => Object.fromEntries((checklistSpec ?? []).map((field) => [field, {
    value: crystal.checklist[field]?.value ?? "", conflict: crystal.checklist[field]?.conflict ?? false
  }])));
  const [note, setNote] = useState("");
  const [name, setName] = useState(crystal.name);
  const formal = crystal.stage === "formal";
  const dirty = Object.entries(fields).some(([field, entry]) => entry.value !== (crystal.checklist[field]?.value ?? "")
    || entry.conflict !== (crystal.checklist[field]?.conflict ?? false));
  return <section className="crystal-detail" aria-label="结晶详情">
    <header><span className="crystal-status">{formal ? "正式结晶" : crystal.origin === "seed" ? "主动观察 · 候选" : "自然形成 · 候选"}</span>
      <h2>{crystal.name}</h2><p>{detail.materials.length} 份材料{detail.termStats ? ` · ${detail.termStats.turns} 次提及 · ${detail.termStats.days} 天` : ""}</p>
    </header>
    {!formal ? <fieldset className="crystal-types" disabled={busy || dirty}><legend>它属于哪一类？</legend>{Object.entries(typeLabels).map(([type, label]) =>
      <button aria-pressed={crystal.type === type} className={crystal.type === type ? "is-selected" : ""} key={type} onClick={() => { void onRequest({ action: "type", id: crystal.id, type: type as CrystalType }); }} type="button">{label}</button>)}</fieldset> : null}
    {checklistSpec ? <div className="crystal-checklist">
      <div className="crystal-section-heading"><h3>内容清单</h3>{!formal ? <button disabled={busy || dirty || !detail.materials.length} onClick={() => { void onRequest({ action: "prefill", id: crystal.id }); }} type="button">{busy ? "处理中…" : "用材料补全空缺"}</button> : null}</div>
      {checklistSpec.map((field) => <div className="crystal-field" key={field}>
        <label htmlFor={`crystal-${field}`}>{fieldLabels[field] ?? field}{validation.missing.includes(field) ? <small>待补充</small> : null}</label>
        {formal ? <p>{fields[field]?.value}</p> : <textarea id={`crystal-${field}`} disabled={busy} rows={2} value={fields[field]?.value ?? ""}
          onChange={(event) => setFields((current) => ({ ...current, [field]: { ...current[field]!, value: event.target.value } }))} />}
        {crystal.checklist[field]?.sources.length ? <small className="crystal-sources">来源：{crystal.checklist[field]!.sources.map((source) => {
          if (source === "user:manual") return "你填写的内容";
          const index = detail.materials.findIndex((material) => `${material.kind}:${String(material.id)}` === source
            || (material.kind === "turn" && typeof material.ref === "object" && material.ref !== null && "anchorId" in material.ref && `turn:${String(material.ref.anchorId)}` === source));
          return index >= 0 ? `材料 ${index + 1}` : "历史来源";
        }).join("、")}</small> : null}
        {!formal ? <label className="crystal-checkbox"><input checked={fields[field]?.conflict ?? false} disabled={busy} type="checkbox"
          onChange={(event) => setFields((current) => ({ ...current, [field]: { ...current[field]!, conflict: event.target.checked } }))} />存在待解决的冲突</label> : null}
      </div>)}
      {!formal ? <button disabled={busy || !dirty} onClick={() => { void onRequest({ action: "checklist", id: crystal.id, fields }); }} type="button">保存清单</button> : null}
    </div> : <p className="crystal-muted">选择类型后，会显示需要补充的清单。</p>}
    <details className="crystal-materials"><summary>来源材料 · {detail.materials.length}</summary>
      {detail.materials.map((material, index) => <p key={material.id}><strong>{index + 1}. {material.kind === "note" ? "补充笔记" : material.kind === "bundle" ? "会话材料组" : typeof material.ref === "object" && material.ref !== null && "threadId" in material.ref && String(material.ref.threadId).startsWith("activity:") ? "活动摘要" : "会话片段"}</strong><br />
        {detail.materialPreviews[material.id] ?? "原始材料已不可用，来源引用仍保留。"}</p>)}
    </details>
    <form className="crystal-note-form" onSubmit={(event) => { event.preventDefault(); void onRequest({ action: "note", id: crystal.id, text: note }).then((ok) => { if (ok) setNote(""); }); }}>
      <label htmlFor="crystal-note">补充材料</label><textarea disabled={busy || dirty} id="crystal-note" rows={2} maxLength={8000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录一条事实，或补充来源与说明…" />
      <button disabled={busy || dirty || !note.trim()} type="submit">添加材料</button>
    </form>
    {detail.related.length ? <div className="crystal-related"><h3>相关结晶</h3>{detail.related.map((related) => <button disabled={busy || dirty} key={related.id} type="button" onClick={() => { void onRequest({ action: "detail", id: related.id }); }}>{related.name} · {related.shared} 份共同材料</button>)}</div> : null}
    <footer className="crystal-detail-footer">
      {!formal && validation.ready ? <label>确认名称<input disabled={busy} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label> : null}
      <div>{crystal.origin === "seed" && !formal ? <button disabled={busy || dirty || (crystal.slot === undefined && freeSlot === undefined)} type="button"
        onClick={() => { void onRequest({ action: "slot", id: crystal.id, slot: crystal.slot === undefined ? freeSlot! : null }); }}>{crystal.slot === undefined ? "恢复观察" : "收起观察"}</button> : null}
        {crystal.origin === "nucleus" && !formal ? <button disabled={busy || dirty} type="button" onClick={() => { void onRequest({ action: "dormant", id: crystal.id, dormant: !crystal.dormant }); }}>{crystal.dormant ? "继续观察" : "暂缓结晶"}</button> : null}
        {!formal ? <button className="crystal-primary" disabled={busy || dirty || !validation.ready || !name.trim()} type="button" onClick={() => { void onRequest({ action: "confirm", id: crystal.id, name }); }}>确认结晶</button> : null}
        <button className={formal ? "crystal-primary" : ""} disabled={busy || dirty} onClick={onInsert} type="button">引用到聊天</button></div>
      {!formal ? <p className="crystal-muted">{dirty ? "先保存清单，再继续操作。" : validation.ready ? "内容与来源已齐全，由你确认成正式结晶。" : "清单内容、来源和冲突处理完成后即可确认。"}</p> : null}
    </footer>
  </section>;
}
