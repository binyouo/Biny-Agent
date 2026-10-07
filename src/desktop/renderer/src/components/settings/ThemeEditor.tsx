import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cloneAppearanceTheme, generateThemeColors, type SimpleThemeColors } from "../../../../../appearance/editing.js";
import { DEFAULT_SIMPLE_THEME_COLORS, SIMPLE_THEME_PRESETS } from "../../../../../appearance/presets.js";
import { BASE16_KEYS, BASE30_KEYS, type AppearanceMode, type CustomAppearanceTheme, type ThemePalette } from "../../../../../appearance/types.js";
import { ThemePreview } from "./ThemePreview.js";
import { SettingsSegmentedControl } from "./SettingsSegmentedControl.js";

function ColorField({ name, value, disabled, onChange }: { name: string; value: string; disabled: boolean; onChange(value: string): void }): React.JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <label className="theme-color-field"><span>{name}</span><input aria-label={`${name} 色板`} type="color" disabled={disabled} value={value} onChange={event => onChange(event.target.value)} />
    <input aria-label={`${name} 颜色值`} disabled={disabled} value={text} maxLength={7} onChange={event => { setText(event.target.value); if (/^#[\da-f]{6}$/iu.test(event.target.value)) onChange(event.target.value); }} pattern="#[0-9a-fA-F]{6}" required /></label>;
}

export function ThemeEditor({ theme, initialMode, onSave, onClose }: { theme?: CustomAppearanceTheme; initialMode: AppearanceMode; onSave(theme: CustomAppearanceTheme): Promise<void>; onClose(): void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [displayName, setDisplayName] = useState(theme?.displayName ?? "");
  const [themeName] = useState(() => theme?.name ?? `theme-${crypto.randomUUID()}`);
  const [type, setType] = useState<AppearanceMode>(theme?.type ?? initialMode);
  const [advanced, setAdvanced] = useState(Boolean(theme));
  const [simple, setSimple] = useState<SimpleThemeColors>(DEFAULT_SIMPLE_THEME_COLORS);
  const [manual, setManual] = useState(() => theme ? { base_30: { ...theme.base_30 }, base_16: { ...theme.base_16 } } : generateThemeColors(simple, type));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const colors = useMemo(() => advanced ? manual : generateThemeColors(simple, type), [advanced, manual, simple, type]);
  const palette: ThemePalette = { name: theme?.name ?? "preview", type, ...colors };
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => { element.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(cloneAppearanceTheme(palette, themeName, displayName));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  const colorField = (key: string, value: string, onChange: (value: string) => void): React.JSX.Element => <ColorField key={key} name={key} value={value} disabled={saving} onChange={onChange} />;
  return <dialog ref={dialog} className="theme-editor" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} onClick={event => { if (!saving && event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={submit}><header><h2 id={titleId}>{theme ? "编辑主题" : "创建主题"}</h2><button type="button" disabled={saving} onClick={onClose} aria-label="关闭主题编辑器">×</button></header>
      <div className="theme-editor-scroll"><label className="theme-name-field">名称<input autoFocus disabled={saving} value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={80} /></label>
        <SettingsSegmentedControl<AppearanceMode> label="明暗类型" disabled={saving} value={type} onChange={setType} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} />
        <SettingsSegmentedControl label="编辑模式" disabled={saving} value={advanced ? "advanced" : "simple"} onChange={value => { if (value === "advanced") setManual(colors); setAdvanced(value === "advanced"); }} options={[{ value: "simple", label: "简单" }, { value: "advanced", label: "高级" }]} />
        <ThemePreview palette={palette} name={displayName} />
        {!advanced ? <><div className="theme-presets" role="group" aria-label="配色预设">
          {Object.entries(SIMPLE_THEME_PRESETS).map(([id, preset]) => <button key={id} type="button" disabled={saving} onClick={() => { setSimple(preset[type]); if (!displayName) setDisplayName(preset.name); }}>{preset.name}</button>)}
        </div><div className="theme-color-fields">{([["background", "背景颜色"], ["foreground", "文本颜色"], ["accent", "主强调色"], ["secondary", "辅助强调色"]] as const).map(([key, label]) => colorField(label, simple[key], color => setSimple(current => ({ ...current, [key]: color }))))}</div></>
          : <>{([ ["界面颜色 · Base30", "base_30", BASE30_KEYS], ["语法颜色 · Base16", "base_16", BASE16_KEYS] ] as const).map(([label, group, keys]) => <section key={group}><h3>{label}</h3><div className="theme-color-fields">{keys.map(key => colorField(key, (manual[group] as Record<string, string>)[key] ?? "#000000", color => setManual(current => ({ ...current, [group]: { ...current[group], [key]: color } }))))}</div></section>)}</>}
      </div>
      <footer>{error ? <p role="alert">{error}</p> : null}<button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" disabled={saving} className="primary">{saving ? "保存中…" : "保存主题"}</button></footer>
    </form>
  </dialog>;
}
