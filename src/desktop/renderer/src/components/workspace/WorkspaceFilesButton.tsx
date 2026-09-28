import { useEffect, useRef } from "react";
import { Icon } from "../Icon.js";

/** 顶栏文件入口与右栏文件标签共享同一个打开动作。 */
export function WorkspaceFilesButton({ inspectorOpen, onOpenFiles }: {
  inspectorOpen: boolean;
  onOpenFiles(): void;
}): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inspectorOpen && document.activeElement === trigger.current) {
      document.querySelector<HTMLButtonElement>('.desktop-inspector [role="tab"][aria-selected="true"]')?.focus();
    }
  }, [inspectorOpen]);
  return <button
    ref={trigger}
    type="button"
    aria-label="打开文件"
    aria-hidden={inspectorOpen}
    tabIndex={inspectorOpen ? -1 : undefined}
    inert={inspectorOpen}
    className={`biny-toolbar-button biny-files-trigger${inspectorOpen ? " is-inspector-open" : ""}`}
    onClick={onOpenFiles}
  ><Icon name="list-tree" size={15} /></button>;
}
