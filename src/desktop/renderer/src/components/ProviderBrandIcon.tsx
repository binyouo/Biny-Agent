/**
 * 品牌图标渲染器。
 *
 * 图标数据是懒加载的，所以先用同步读缓存出图（已加载过就不会闪兜底字形），
 * 再在 effect 里补一次解析。active 标志防止 iconId 快速切换时旧请求覆盖新图标。
 */
import React, { useEffect, useState } from "react";
import { getCachedProviderIconData, loadProviderIconData } from "./ProviderIconData.js";

export function ProviderBrandIcon({ iconId, className, fallback = null }: {
  iconId?: string | null;
  className?: string;
  fallback?: React.ReactNode;
}): React.JSX.Element {
  const [glyph, setGlyph] = useState(() => (iconId ? getCachedProviderIconData()?.data[iconId] ?? null : null));

  useEffect(() => {
    if (!iconId) {
      setGlyph(null);
      return;
    }
    let active = true;
    loadProviderIconData()
      .then((loaded) => { if (active) setGlyph(loaded.data[iconId] ?? null); })
      .catch(() => { if (active) setGlyph(null); });
    return () => { active = false; };
  }, [iconId]);

  if (!glyph) return <>{fallback}</>;
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox={glyph.vb}
      dangerouslySetInnerHTML={{ __html: glyph.body }}
    />
  );
}
