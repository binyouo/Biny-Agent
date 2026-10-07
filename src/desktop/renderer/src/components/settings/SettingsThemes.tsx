import { useMemo, useRef, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { cloneAppearanceTheme, exportAppearanceTheme, getAppearancePalette, importAppearanceTheme, upsertAppearanceTheme } from "../../../../../appearance/editing.js";
import { appearancePreferenceSchema, listAppearanceThemes } from "../../../../../appearance/preferences.js";
import { palettePreviewColors } from "../../../../../appearance/palette.js";
import type { AppearanceMode, AppearancePreference, CustomAppearanceTheme } from "../../../../../appearance/types.js";
import { ThemeEditor } from "./ThemeEditor.js";

export function SettingsThemes({ preference, onChange, disabled }: { preference: AppearancePreference; onChange(preference: AppearancePreference): Promise<boolean>; disabled?: boolean }): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{ type: AppearanceMode; theme?: CustomAppearanceTheme }>();
  const [pendingDelete, setPendingDelete] = useState<CustomAppearanceTheme>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const themes = useMemo(() => listAppearanceThemes(preference).filter(theme => `${theme.id} ${theme.displayName}`.toLowerCase().includes(search.trim().toLowerCase())), [preference, search]);
  const change = (next: AppearancePreference): boolean => {
    try { onChange(appearancePreferenceSchema.parse(next) as AppearancePreference); setError(undefined); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
  };
  const closeDelete = (): void => { setPendingDelete(undefined); setError(undefined); };
  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const id = `custom:${pendingDelete.name}`;
    if (change({ ...preference,
      darkTheme: preference.darkTheme === id ? null : preference.darkTheme,
      lightTheme: preference.lightTheme === id ? null : preference.lightTheme,
      customThemes: preference.customThemes.filter(theme => theme.name !== pendingDelete.name)
    })) closeDelete();
  };
  const save = async (theme: CustomAppearanceTheme): Promise<void> => {
    if (await onChange(upsertAppearanceTheme(preference, theme, editor?.theme?.name)) === false) {
      throw new Error("主题保存失败，请重试。");
    }
    setError(undefined);
    setEditor(undefined);
  };
  const download = (id: string, displayName: string): void => {
    const palette = getAppearancePalette(id, preference.customThemes)!;
    const url = URL.createObjectURL(new Blob([exportAppearanceTheme(palette, displayName)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${palette.name}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const importFile = async (file?: File): Promise<void> => {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error("主题文件不能超过 256 KiB。");
      const theme = importAppearanceTheme(await file.text(), `theme-${crypto.randomUUID()}`);
      setEditor({ type: theme.type, theme });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    if (fileInput.current) fileInput.current.value = "";
  };
  return <div className="settings-theme-page"><fieldset className="settings-appearance-fieldset" disabled={disabled}>
    <div className="theme-page-toolbar"><input type="search" aria-label="搜索主题" placeholder="搜索主题…" value={search} onChange={event => setSearch(event.target.value)} />
      <button type="button" onClick={() => setEditor({ type: "dark" })}>创建主题</button><button type="button" onClick={() => fileInput.current?.click()}>导入主题</button>
      <input ref={fileInput} type="file" accept=".json,.lua" hidden onChange={event => { void importFile(event.target.files?.[0]); }} /></div>
    {error && !pendingDelete ? <p role="alert">{error}</p> : null}
    {(["dark", "light"] as const).map(type => {
      const field = type === "dark" ? "darkTheme" : "lightTheme";
      const selected = preference[field];
      return <section className="theme-mode-section" key={type}><h3>{type === "dark" ? "深色主题" : "浅色主题"}</h3><div className="theme-grid">
        <button type="button" className="theme-card theme-card-default" aria-pressed={selected === null} onClick={() => change({ ...preference, [field]: null })}><div className="theme-swatches theme-default-swatches"><span /><span /><span /></div><span>默认</span>{selected === null ? <span className="theme-card-check" aria-hidden="true">✓</span> : null}</button>
        {themes.filter(theme => theme.type === type).map(theme => {
          const palette = getAppearancePalette(theme.id, preference.customThemes)!;
          const custom = theme.id.startsWith("custom:");
          return <div className="theme-card-wrapper" key={theme.id}><button type="button" className="theme-card" aria-pressed={selected === theme.id} onClick={() => change({ ...preference, [field]: theme.id })}>
            <div className="theme-swatches">{palettePreviewColors(palette).map((color, index) => <span key={index} style={{ background: color }} />)}</div><span>{theme.displayName}</span>{selected === theme.id ? <span className="theme-card-check" aria-hidden="true">✓</span> : null}</button>
            <div className="theme-card-actions"><button type="button" aria-label={`${custom ? "编辑" : "克隆"} ${theme.displayName}`} onClick={() => setEditor({ type, theme: custom ? palette as CustomAppearanceTheme : cloneAppearanceTheme(palette, `theme-${crypto.randomUUID()}`, `${theme.displayName} 副本`) })}>{custom ? "编辑" : "克隆"}</button>
              <button type="button" aria-label={`导出 ${theme.displayName}`} onClick={() => download(theme.id, theme.displayName)}>导出</button>
              {custom ? <button type="button" aria-label={`删除 ${theme.displayName}`} onClick={() => { setError(undefined); setPendingDelete(palette as CustomAppearanceTheme); }}>删除</button> : null}</div>
          </div>;
        })}</div>{themes.every(theme => theme.type !== type) && search ? <p>没有匹配的主题。</p> : null}</section>;
    })}
    {preference.lightTheme === "win98" ? <label className="theme-trail-option"><input type="checkbox" checked={preference.win98Trail} onChange={event => change({ ...preference, win98Trail: event.target.checked })} />Windows 98 窗口拖影<span>拖动窗口时留下冻结帧残影；仅 Windows 98 皮肤启用。</span></label> : null}
  </fieldset>{editor ? <ThemeEditor theme={editor.theme} initialMode={editor.type} onSave={save} onClose={() => setEditor(undefined)} /> : null}
    {pendingDelete ? <Dialog aria-label="删除主题" className="theme-delete-dialog" isOpen onOpenChange={isOpen => { if (!isOpen) closeDelete(); }} purpose="info" width={420} padding={4}>
      <h2>删除主题</h2><p>确定删除“{pendingDelete.displayName}”吗？如果正在使用，将恢复默认配色。</p>
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" aria-label="取消删除主题" onClick={closeDelete}>取消</button><button type="button" aria-label="确认删除主题" disabled={disabled} onClick={confirmDelete}>删除</button></footer>
    </Dialog> : null}
  </div>;
}
