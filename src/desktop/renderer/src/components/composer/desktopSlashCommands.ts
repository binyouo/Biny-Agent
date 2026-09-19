/**
 * Desktop Composer 的命令展示数据。
 *
 * TUI 与 Desktop 共用执行协议，但两端的入口职责不同：桌面端的信息展示由专属 UI 承担
 * （用量浮层、设置页、能力菜单），纯展示类命令不进入补全列表，只保留对动作类命令的
 * 入口，并把当前有效 Skill 作为同一份补全数据源。
 */
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { DesktopSkillCatalogEntry, DesktopSlashCommand } from "../../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../../protocol.js";
import type { IconName } from "../Icon.js";

export const DESKTOP_COMPOSER_COMMAND_NAMES = [
  "/compact",
  "/subagent",
  "/review",
  "/undo"
] as const;

interface CommandPresentation {
  group: string;
  description: string;
  /** 命令接受参数时展示在命令名后的参数提示；无参命令省略。 */
  hint?: string;
  icon: IconName;
}

const COMMAND_PRESENTATIONS: Record<typeof DESKTOP_COMPOSER_COMMAND_NAMES[number], CommandPresentation> = {
  "/compact": {
    group: "上下文",
    description: "压缩较早的对话历史，为当前任务释放上下文空间",
    hint: "提示",
    icon: "archive"
  },
  "/subagent": {
    group: "扩展能力",
    description: "启动、查看、取消或列出子代理任务",
    hint: "start | status | cancel | agents",
    icon: "person"
  },
  "/review": {
    group: "扩展能力",
    description: "让子代理审查当前工作区的变更和风险",
    hint: "重点",
    icon: "search"
  },
  "/undo": {
    group: "工作区",
    description: "从 Biny 检查点恢复工作区文件",
    hint: "checkpoint",
    icon: "arrow-left"
  }
};

export type DesktopComposerItemData =
  | {
    kind: "command";
    group: string;
    description: string;
    hint?: string;
    icon: IconName;
    keywords: string[];
    commandName: string;
    acceptsArgs: boolean;
    skill: undefined;
  }
  | {
    kind: "skill";
    group: string;
    description: string;
    hint: undefined;
    icon: IconName;
    keywords: string[];
    commandName: undefined;
    acceptsArgs: false;
    skill: DesktopSkillCatalogEntry;
  };

export type DesktopComposerItem = SearchableItem<DesktopComposerItemData>;

const desktopComposerCommandNames = new Set<string>(DESKTOP_COMPOSER_COMMAND_NAMES);

export function buildDesktopComposerItems(skills: readonly DesktopSkillCatalogEntry[]): DesktopComposerItem[] {
  const commandItems = DESKTOP_SLASH_COMMANDS
    .filter((command) => desktopComposerCommandNames.has(command.name))
    .flatMap((command) => {
      const presentation = COMMAND_PRESENTATIONS[command.name as typeof DESKTOP_COMPOSER_COMMAND_NAMES[number]];
      if (!presentation) return [];
      return [{
        id: command.name,
        label: command.name,
        auxiliaryData: {
          kind: "command" as const,
          group: presentation.group,
          description: presentation.description,
          hint: presentation.hint,
          icon: presentation.icon,
          keywords: [command.name, presentation.description],
          commandName: command.name,
          acceptsArgs: command.acceptsArgs === true,
          skill: undefined
        }
      } satisfies DesktopComposerItem];
    });

  const uniqueSkills = new Map<string, DesktopSkillCatalogEntry>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!uniqueSkills.has(key)) uniqueSkills.set(key, skill);
  }
  const skillItems = [...uniqueSkills.values()]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((skill) => ({
      id: `/skills:${skill.name}`,
      label: `/skills:${skill.name}`,
      auxiliaryData: {
        kind: "skill" as const,
        group: "Skills",
        description: skill.description || "调用此技能处理当前任务",
        hint: undefined,
        icon: "wand" as const,
        keywords: [skill.name, skill.description],
        commandName: undefined,
        acceptsArgs: false as const,
        skill
      }
    } satisfies DesktopComposerItem));

  return [...commandItems, ...skillItems];
}

export function desktopCommandForName(name: string): DesktopSlashCommand | undefined {
  return DESKTOP_SLASH_COMMANDS.find((command) => command.name === name);
}
