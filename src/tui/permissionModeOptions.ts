/**
 * 权限模式选择项。
 *
 * 只描述可在界面上切换的三种模式；`read-only` 由外部配置设置，不出现在
 * 选择列表里。
 */
import type { PermissionMode } from "../permission/PermissionManager.js";

export interface PermissionModeOption {
  mode: Extract<PermissionMode, "ask" | "auto" | "full-access">;
  label: string;
  description: string;
}

export const permissionModeOptions: PermissionModeOption[] = [
  {
    mode: "ask",
    label: "Ask for approval",
    description: "Ask before file edits, shell commands, and other write actions."
  },
  {
    mode: "auto",
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe."
  },
  {
    mode: "full-access",
    label: "Full Access",
    description: "Allow normal workspace edits and commands without asking; critical actions may still ask."
  }
];
