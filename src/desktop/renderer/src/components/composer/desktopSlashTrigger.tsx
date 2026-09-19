/** Desktop Composer 的 slash trigger：负责富信息行和 Skill token 的渲染。 */
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import type { ChatComposerToken, ChatComposerTrigger } from "@astryxdesign/core/Chat";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { DesktopSkillCatalogEntry } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import {
  buildDesktopComposerItems,
  desktopCommandForName,
  type DesktopComposerItemData
} from "./desktopSlashCommands.js";

export function createDesktopSlashTrigger(skills: readonly DesktopSkillCatalogEntry[]): ChatComposerTrigger {
  const items = buildDesktopComposerItems(skills);
  return {
    character: "/",
    searchSource: createStaticSource(items, {
      keywords: (item) => item.auxiliaryData?.keywords ?? []
    }),
    renderItem: renderDesktopSlashItem,
    onSelect: (item) => {
      const data = itemData(item);
      if (data.kind === "skill") return createSkillToken(data.skill);
      const command = desktopCommandForName(data.commandName);
      if (!command) return item.label;
      return command.requiresArgs || command.acceptsArgs ? `${command.name} ` : command.name;
    },
    emptySearchResultsText: "没有匹配的命令或技能",
    menuLabel: "命令和技能"
  };
}

function itemData(item: SearchableItem): DesktopComposerItemData {
  return item.auxiliaryData as DesktopComposerItemData;
}

/**
 * 行渲染保持单行命令名（等宽字体）和可选参数提示，第二行只放一句截断的描述；
 * 类型差异交给分组标题和图标颜色，不再使用右侧徽标和多行堆叠。
 */
function renderDesktopSlashItem(item: SearchableItem): React.ReactNode {
  const data = itemData(item);
  return (
    <div className={`desktop-slash-option is-${data.kind}`}>
      <span className="desktop-slash-option-icon"><Icon name={data.icon} size={14} /></span>
      <span className="desktop-slash-option-copy">
        <span className="desktop-slash-option-name">
          <code>{item.label}</code>
          {data.hint ? <em className="desktop-slash-option-hint">{"<"}{data.hint}{">"}</em> : undefined}
        </span>
        <span className="desktop-slash-option-desc">{data.description}</span>
      </span>
    </div>
  );
}

function createSkillToken(skill: DesktopSkillCatalogEntry): ChatComposerToken {
  return {
    value: `/skills:${skill.name}`,
    render: () => (
      <span className="desktop-skill-token" data-skill-name={skill.name}>
        <Icon name="wand" size={14} />
        <span>{skill.name}</span>
      </span>
    )
  };
}
