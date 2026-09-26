/** 聊天参数、展示偏好、能力范围和压缩共用一个草稿与保存事务。 */
import type { ChatResponseSettings } from "../../../../../config/schema.js";
import { DEFAULT_CHAT_RESPONSE } from "../../chatResponseSettings.js";
import { SettingsChatParams } from "./SettingsChatParams.js";
import { SettingsCapabilityDefaults } from "./SettingsCapabilityDefaults.js";
import { SettingsCompaction } from "./SettingsCompaction.js";
import { SettingsCheckbox } from "./SettingsCheckbox.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const responseOptions: Array<{ key: keyof ChatResponseSettings; label: string; detail: string }> = [
  { key: "streaming", label: "启用流式响应", detail: "生成时逐步显示回复；关闭后，每段回复生成完成后一次显示。" },
  { key: "showTokenUsage", label: "显示令牌使用情况", detail: "在回复菜单中显示本轮的令牌用量统计。" },
  { key: "markdown", label: "启用 Markdown 渲染", detail: "显示标题、列表、代码、表格与公式；关闭后显示原始文本。" },
  { key: "singleDollarMath", label: "渲染单美元符号数学公式", detail: "将 $x+y$ 识别为公式。关闭可避免金额文本被误识别，双美元公式仍正常显示。" },
  { key: "collapseThinking", label: "默认折叠思考过程", detail: "思考结束后默认收起，仍可手动展开查看；工具操作和权限确认保持可见。" },
  { key: "openLinksInBrowser", label: "在内置浏览器打开链接", detail: "回复中的网页链接在内置浏览器打开；按住 Cmd/Ctrl 点击则使用系统浏览器。" }
];

export function SettingsChatPage(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p>正在加载聊天设置…</p></section></div>;
  const response = { ...DEFAULT_CHAT_RESPONSE, ...draft.chatParams.response };
  return <div className="settings-chat-page">
    <SettingsChatParams />
    <div className="settings-sections"><section><h3>响应设置</h3>
      {responseOptions.map(({ key, label, detail }) => <SettingsCheckbox key={key} label={label} detail={detail}
        checked={response[key]} disabled={key === "singleDollarMath" && !response.markdown}
        onChange={(value) => setChatParams({ ...draft.chatParams, response: { ...draft.chatParams.response, [key]: value } })} />)}
    </section></div>
    <SettingsCapabilityDefaults />
    <SettingsCompaction />
    <div className="settings-sections"><section><h3>编辑工具模式</h3>
      <SettingsCheckbox checked={draft.chatParams.hashlineEdit === true} label="Hashline 编辑模式（实验）"
        detail="Read 输出行哈希，Edit 通过行标签定位修改。保存后从下一回合生效。"
        onChange={(hashlineEdit) => setChatParams({ ...draft.chatParams, hashlineEdit })} />
    </section></div>
  </div>;
}
