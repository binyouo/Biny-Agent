/**
 * Desktop 工作树的用户可见状态。
 *
 * 这里刻意只把生命周期和安全边界翻译成短文案；路径、分支名和 base commit
 * 属于诊断信息，不进入普通会话 UI。按钮是否出现也在这里统一决定，避免组件
 * 各自对 dirty / orphaned 做出不同判断。
 */
import type { DesktopWorktreeStatus } from "../../protocol.js";

export type DesktopWorktreeTone = "neutral" | "positive" | "warning" | "danger";

export interface DesktopWorktreeViewModel {
  label: string;
  detail: string;
  tone: DesktopWorktreeTone;
  canMerge: boolean;
  canRemove: boolean;
  deleteBranchOnRemove: boolean;
}

export function desktopWorktreeView(status: DesktopWorktreeStatus | undefined): DesktopWorktreeViewModel {
  if (status === undefined) {
    return {
      label: "隔离工作树",
      detail: "正在读取状态…",
      tone: "neutral",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (!status.exists) {
    return {
      label: "工作树不可用",
      detail: "目录不存在，Biny 未自动删除登记。",
      tone: "warning",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (status.dirty) {
    return {
      label: "有未提交改动",
      detail: "工作树已保留；提交或手动处理后再合并。",
      tone: "warning",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (status.status === "conflicted") {
    return {
      label: "有合并冲突",
      detail: "隔离工作树已保留，请手动处理冲突。",
      tone: "danger",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (status.status === "orphaned") {
    return {
      label: "待人工处理",
      detail: "无法证明可以安全回收，Biny 不会自动删除。",
      tone: "warning",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (status.status === "kept") {
    return {
      label: "已保留",
      detail: "此前清理未执行，用户改动仍在。",
      tone: "warning",
      canMerge: false,
      canRemove: false,
      deleteBranchOnRemove: false
    };
  }
  if (status.mergedIntoBase) {
    return {
      label: "已合并",
      detail: "改动已进入项目主分支，可以清理隔离环境。",
      tone: "positive",
      canMerge: false,
      canRemove: true,
      deleteBranchOnRemove: true
    };
  }
  return {
    label: "可合并",
    detail: "当前工作树干净，可以合并到项目主分支。",
    tone: "neutral",
    canMerge: true,
    canRemove: true,
    deleteBranchOnRemove: false
  };
}
