/** 通用设置：主题与界面字体。 */
import { NativeSelect } from "../NativeSelect.js";
import { useEffect, useState } from "react";
import type { DesktopFontPreference, DesktopThemePreference } from "../../../../protocol.js";
import { clampFontSize, DEFAULT_FONT_PREFERENCE, MAX_FONT_SIZE, MIN_FONT_SIZE, SYSTEM_FONT_FAMILY } from "../../../../fontPreference.js";
import { SettingsSegmentedControl } from "./SettingsSegmentedControl.js";
import type { AppearanceDensity } from "../../../../../appearance/types.js";

const fontFamilyOptions: Array<{ value: string; title: string }> = [
  { value: SYSTEM_FONT_FAMILY, title: "系统默认" },
  { value: "PingFang SC", title: "苹方" },
  { value: "Hiragino Sans GB", title: "冬青黑体" },
  { value: "Noto Sans SC", title: "思源黑体" },
  { value: "Songti SC", title: "宋体" },
  { value: "Kaiti SC", title: "楷体" },
  { value: "Yuanti SC", title: "圆体" }
];

export function SettingsAppearance({ theme, onThemeChange, font, onFontChange, density, onDensityChange, disabled }: {
  theme: DesktopThemePreference;
  onThemeChange(theme: DesktopThemePreference): void;
  font: DesktopFontPreference;
  onFontChange(font: DesktopFontPreference): void;
  density?: AppearanceDensity;
  onDensityChange?(density: AppearanceDensity): void;
  disabled?: boolean;
}): React.JSX.Element {
  // 字号输入允许中间态（比如清空后再输入），失焦或回车时才夹取并提交。
  const [sizeText, setSizeText] = useState(String(font.size));
  useEffect(() => {
    setSizeText(String(font.size));
  }, [font.size]);
  const commitSize = (): void => {
    const parsed = Number(sizeText);
    const next = Number.isFinite(parsed) && sizeText.trim() !== "" ? clampFontSize(parsed) : font.size;
    setSizeText(String(next));
    if (next !== font.size) onFontChange({ ...font, size: next });
  };
  const changeSize = (value: string): void => {
    setSizeText(value);
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE && parsed !== font.size) {
      onFontChange({ ...font, size: parsed });
    }
  };
  const familyOptions = fontFamilyOptions.some((option) => option.value === font.family)
    ? fontFamilyOptions
    : [...fontFamilyOptions, { value: font.family, title: font.family }];
  return (
    <fieldset aria-label="通用偏好" className="settings-preferences appearance-settings" disabled={disabled}>
      <section className="settings-preference-section">
        <h3>外观</h3>
        <div className="settings-row-group">
          <div className="settings-preference-row" id="appearance-theme">
            <div className="settings-row-copy"><strong>主题</strong><p>选择浅色、深色，或随系统切换。</p></div>
            <SettingsSegmentedControl label="外观" value={theme} onChange={onThemeChange} options={[
              { value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }
            ]} />
          </div>
        {onDensityChange ? <div className="settings-preference-row"><div className="settings-row-copy"><label>界面密度</label><p>调整控件高度、间距和行高。</p></div><SettingsSegmentedControl label="界面密度" value={density ?? "compact"} onChange={onDensityChange} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }, { value: "spacious", label: "宽松" }]} /></div> : null}
        </div>
      </section>
      <section className="settings-preference-section">
        <h3>字体与阅读</h3>

        <div className="settings-row-group">
          <div className="settings-preference-row" id="appearance-font">
            <div className="settings-row-copy"><label htmlFor="appearance-font-family">界面字体</label><p>使用本机已安装的字体。</p></div>
            <NativeSelect
              id="appearance-font-family"
              onChange={(event) => onFontChange({ ...font, family: event.target.value })}
              value={font.family}
            >
              {familyOptions.map((option) => <option key={option.value} value={option.value}>{option.title}</option>)}
            </NativeSelect>
          </div>
          <div className="settings-preference-row">
            <div className="settings-row-copy"><label htmlFor="appearance-font-size">字体大小</label><p>同步调整界面文字与控件尺寸。</p></div>
            <div className="font-size-row">
              <input
                className="font-size-input"
                id="appearance-font-size"
                max={MAX_FONT_SIZE}
                min={MIN_FONT_SIZE}
                onBlur={commitSize}
                onChange={(event) => changeSize(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitSize();
                }}
                step={1}
                type="number"
                value={sizeText}
              />
              <span className="font-size-unit">px</span>
            </div>
          </div>
          <div className="settings-font-preview" aria-label="字体预览">
            <p style={{ fontFamily: font.family === SYSTEM_FONT_FAMILY ? undefined : `"${font.family.replaceAll('"', '')}", var(--font-sans-stack)`, fontSize: font.size }}>
              这是一段文字预览，用于检查字号和阅读效果。<br /><span>The quick brown fox jumps over the lazy dog. 0123456789</span>
            </p>
            <button aria-label="恢复默认字体" className="settings-text-action" disabled={font.family === SYSTEM_FONT_FAMILY && font.size === DEFAULT_FONT_PREFERENCE.size}
              onClick={() => onFontChange({ ...DEFAULT_FONT_PREFERENCE })} type="button">恢复默认</button>
          </div>
        </div>
      </section>
    </fieldset>
  );
}
