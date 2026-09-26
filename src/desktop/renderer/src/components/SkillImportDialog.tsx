/** 导入其他 Agent 已存在的 Skill；这里只提交候选 id，绝对路径仍由主进程重新扫描解析。 */
import { Dialog } from "@astryxdesign/core/Dialog";
import { createPortal } from "react-dom";
import { memo, useState } from "react";
import type { DesktopSkillEngine, DesktopSkillImportCandidate } from "../../../protocol.js";
import { Icon } from "./Icon.js";

const skillEngineLabels: Record<DesktopSkillEngine, string> = {
  biny: "Biny",
  claude: "Claude",
  codex: "Codex",
  pi: "Pi"
};

function formatSkillImportSources(foundIn: DesktopSkillEngine[]): string {
  return foundIn.length ? foundIn.map((engine) => skillEngineLabels[engine]).join("、") : "本地技能目录";
}

export const SkillImportDialog = memo(function SkillImportDialog({ candidates, importing, onClose, onImport }: {
  candidates: DesktopSkillImportCandidate[];
  importing: boolean;
  onClose(): void;
  onImport(ids: string[]): void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((candidate) => candidate.id)));
  const selectedCount = selected.size;
  const allSelected = selectedCount === candidates.length && candidates.length > 0;

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 设置本身是原生模态窗口；独立挂载避免被内容区裁切，也避免 Escape 传给底层窗口。
  return createPortal(
    <Dialog aria-label="导入已有技能" isOpen onOpenChange={(open) => { if (!open && !importing) onClose(); }}
      padding={0} purpose={importing ? "required" : "info"} width="min(760px, calc(100vw - 48px))" maxHeight="calc(100dvh - 48px)">
      <section className="biny-skill-import-dialog">
        <div className="biny-skill-dialog-heading"><div><h2>导入已有</h2><p>选择要导入到 Biny 统一管理的技能</p></div><button aria-label="关闭导入已有" disabled={importing} onClick={onClose} type="button"><Icon name="close" size={18} /></button></div>
        {candidates.length ? <>
          <button className="biny-skill-import-select-all" disabled={importing} onClick={() => setSelected(allSelected ? new Set() : new Set(candidates.map((candidate) => candidate.id)))} type="button">{allSelected ? "取消全选" : "全选"}</button>
          <div className="biny-skill-import-list">
            {candidates.map((candidate) => <label className="biny-skill-import-item" key={candidate.id}>
              <input checked={selected.has(candidate.id)} disabled={importing} onChange={() => toggle(candidate.id)} type="checkbox" />
              <span className="biny-skill-import-item-main">
                <strong>{candidate.name}</strong>
                <span className="biny-skill-import-item-description">{candidate.description}</span>
                <span className="biny-skill-import-item-source"><span className="biny-skill-import-item-source-label">导入来源</span>{formatSkillImportSources(candidate.foundIn)}</span>
                <code className="biny-skill-import-item-path">来源路径：{candidate.path}</code>
              </span>
            </label>)}
          </div>
        </> : <div className="biny-skill-import-empty"><Icon name="check" size={22} /><strong>没有发现待导入的技能</strong><span>已有全局技能都已被 Biny 管理，或当前目录没有可识别的 SKILL.md。</span></div>}
        <div className="biny-skill-dialog-footer"><button disabled={importing} onClick={onClose} type="button">取消</button><button className="is-primary" disabled={!selectedCount || importing} onClick={() => onImport([...selected])} type="button">{importing ? "导入中…" : `导入已选 (${String(selectedCount)})`}</button></div>
      </section>
    </Dialog>, document.body
  );
});
