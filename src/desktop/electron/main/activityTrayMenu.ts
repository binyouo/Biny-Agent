/** Activity 托盘菜单只表达运行态与操作入口，动作由主进程装配。 */
import type { MenuItemConstructorOptions } from "electron";
import type { ActivityServiceState } from "../../../activity/types.js";

export interface ActivityTrayActions {
  open(): void;
  toggle(): void;
  summary(): void;
  settings(): void;
  quit(): void;
}

const statusLabels: Record<ActivityServiceState, string> = {
  stopped: "已停止",
  paused: "已暂停",
  running: "正在记录",
  permission_required: "需要系统权限",
  unavailable: "当前不可用",
  error: "记录出错"
};

export function activityTrayItems(state: ActivityServiceState, actions: ActivityTrayActions): MenuItemConstructorOptions[] {
  return [
    { label: "打开 Biny", click: () => actions.open() },
    { type: "separator" },
    { label: `电脑历史：${statusLabels[state]}`, enabled: false },
    { label: state === "paused" || state === "stopped" ? "开始记录电脑历史" : "暂停记录电脑历史", click: () => actions.toggle() },
    { label: "生成今日摘要", click: () => actions.summary() },
    { label: "电脑历史设置…", click: () => actions.settings() },
    { type: "separator" },
    { label: "退出 Biny", click: () => actions.quit() }
  ];
}
