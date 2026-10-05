/** 按需读取受管版本，更新和回滚都携带当前版本，拒绝覆盖并发切换或用户文件修改。 */
import { useEffect, useRef, useState } from "react";
import type { ManagedSkillVersion } from "../../../../extensions/skillVersions.js";

export function SkillVersionControls({ skillId, disabled, onChanged, onError, refreshKey }: { skillId: string; disabled: boolean; onChanged(skillId: string): void; refreshKey?: unknown; onError(message: string): void }): React.JSX.Element | null {
  const [version, setVersion] = useState<ManagedSkillVersion>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    let active = true;
    // Recheck a refreshed catalog entry before offering versioned actions.
    if (refreshKey !== undefined) setVersion(undefined);
    void window.biny.skillVersion(skillId).then((next) => { if (active) setVersion(next); }).catch((error) => { if (active) onError(String(error)); });
    return () => { active = false; };
  }, [skillId, onError, refreshKey]);
  const changeVersion = async (rollback: boolean): Promise<void> => {
    if (!version || busy) return;
    const current = ++generation.current;
    setBusy(true); setNotice(undefined);
    try {
      if (rollback) {
        const restored = await window.biny.rollbackSkillVersion(skillId, version.id);
        if (current === generation.current) {
          setVersion(restored); setNotice("已回滚到上一版本。");
        }
      } else {
        const updated = await window.biny.updateSkillVersion(skillId, version.id);
        if (current === generation.current) {
          setVersion(updated.version);
          setNotice(updated.version.id === version.id ? "已是最新版本。" : "已更新。");
        }
      }
      // A committed mutation outlives these controls; the parent owns cache
      // invalidation and decides whether its own lifetime is still active.
      onChanged(skillId);
    } catch (error) { if (current === generation.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  if (!version) return null;
  return <section className="biny-skill-version" aria-label="Skill 版本">
    <p>{version.source.owner}/{version.source.repository} · {version.revision.slice(0, 12)}</p>
    <div className="biny-skill-detail-actions"><button disabled={busy || disabled} onClick={() => void changeVersion(false)} type="button">{busy ? "处理中…" : "检查并更新"}</button><button disabled={busy || disabled || !version.previous} onClick={() => void changeVersion(true)} type="button">回滚上一版本</button></div>
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
