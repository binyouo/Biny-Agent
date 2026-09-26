/** 聊天采样参数分页：温度与最大输出令牌，统一走设置草稿，保存时进入主进程事务。 */
import type { DesktopChatParamsSettings } from "../../../../protocol.js";
import { OptionalNumberField } from "./SettingsCompaction.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

/** 温度滑块的展示默认值；未配置时不下发 temperature，由模型/provider 自行决定。 */
const temperatureDisplayDefault = 0.7;

export function SettingsChatParams(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载聊天参数…</p></section></div>;
  const chatParams = draft.chatParams;
  const update = (patch: Partial<DesktopChatParamsSettings>): void => setChatParams({ ...chatParams, ...patch });

  const temperatureSet = chatParams.temperature !== undefined;

  return (
    <div className="settings-sections chat-params-settings">
      <section id="chat-params-temperature" tabIndex={-1}>
        <h3>聊天参数</h3>
        <label className="compaction-threshold-field">
          <span>
            <strong>温度</strong>
            <em>{temperatureSet ? chatParams.temperature?.toFixed(1) : "模型默认"}</em>
          </span>
          <input
            aria-label="温度"
            max={200}
            min={0}
            onChange={(event) => update({ temperature: Number(event.target.value) / 100 })}
            style={{ "--range-progress": `${((chatParams.temperature ?? temperatureDisplayDefault) / 2) * 100}%` } as React.CSSProperties}
            type="range"
            value={Math.round((chatParams.temperature ?? temperatureDisplayDefault) * 100)}
          />
          <span className="chat-temperature-scale"><i>精确 0.0</i><i>平衡 1.0</i><i>创造 2.0</i></span>
        </label>
        <small className="compaction-hint">控制回复的随机性。较低的值更稳定，较高的值更发散。</small>
        {temperatureSet ? (
          <small className="compaction-hint">
            <button className="chat-temperature-reset" onClick={() => update({ temperature: undefined })} type="button">恢复模型默认</button>
          </small>
        ) : null}
        <OptionalNumberField
          id="chat-max-output-tokens"
          label="最大令牌数"
          hint="单次回复的最大 token 数，留空使用模型默认值。"
          max={131_072}
          min={256}
          onCommit={(maxOutputTokens) => update({ maxOutputTokens })}
          unit="tokens"
          value={chatParams.maxOutputTokens}
        />
      </section>
    </div>
  );
}
