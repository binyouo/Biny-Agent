/**
 * 视觉模型（预留位置）。
 *
 * 对齐 Alma 通用页把后台模型拆成「工具模型 / 视觉模型」两张卡片的做法。
 * 现在只落位置与说明：开关是 disabled 的占位，等主模型识图能力接好再挂真实设置项。
 */
import { SettingsSwitch } from "./SettingsSwitch.js";

export function SettingsVisionModel(): React.JSX.Element {
  return (
    <div className="settings-preferences">
      <section className="settings-preference-section" id="vision-model" tabIndex={-1}>
        <h3>视觉模型</h3>
        <div className="settings-row-group">
          <SettingsSwitch
            checked={false}
            detail="默认关闭，图片直接发给主模型（视主模型为支持识图）。开启后，主模型不支持识图时，先用指定的视觉模型把图片识别成文字，再交给主模型处理。"
            disabled
            label="用独立的视觉模型处理图片"
            onChange={() => undefined}
          />
        </div>
      </section>
    </div>
  );
}
