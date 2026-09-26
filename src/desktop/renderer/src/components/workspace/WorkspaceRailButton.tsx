/** 工作区右侧工具按钮的提示与可访问名称。 */
import React from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";

export function WorkspaceRailButton({ label, tabIndex, onClick, children, tooltip = true }: {
  label: string;
  tabIndex: number;
  onClick(): void;
  children: React.ReactNode;
  tooltip?: boolean;
}): React.JSX.Element {
  const button = <button aria-label={label} className="biny-inspector-rail-btn" tabIndex={tabIndex} onClick={onClick} type="button">{children}</button>;
  return tooltip ? <Tooltip content={label} delay={150} placement="start">{button}</Tooltip> : button;
}
