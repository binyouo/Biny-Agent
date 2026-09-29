/**
 * 弹层组件。
 *
 * 选择器、权限确认和长文本查看都以叠层形式出现在输入框之上：
 * 顶部一条分隔线加标题，中间是内容，底部是键位提示。键盘输入由终端框架的
 * 焦点机制直接投递给组件的 `handleInput`。
 */
import { permissionPresentation } from "../../permission/presentation.js";
import {
  Container,
  Input,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  type Component,
  type SelectItem
} from "@earendil-works/pi-tui";
import { selectListTheme, theme } from "../theme/index.js";
import {
  appendPermissionReason,
  appendPermissionConfirmation,
  confirmedPermissionChoice,
  DEFAULT_PERMISSION_SELECTION,
  movePermissionSelection,
  permissionChoiceAt,
  permissionOptions
} from "../permissionOptions.js";
import type { PermissionChoice, TuiPermissionRequest } from "../types.js";

/** 弹层外框：上下分隔线 + 标题 + 提示。 */
class DialogFrame implements Component {
  constructor(
    private readonly title: string,
    private readonly hint: string,
    private readonly position: "top" | "bottom"
  ) {}

  invalidate(): void {
    // 无缓存。
  }

  render(width: number): string[] {
    const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
    if (this.position === "bottom") {
      return this.hint ? [` ${theme.fg("dim", truncateToWidth(this.hint, width - 1, "…"))}`, rule] : [rule];
    }
    const lines = [rule, ` ${theme.fg("accent", theme.bold(truncateToWidth(this.title, width - 1, "…")))}`];
    return lines;
  }
}

/** 通用列表选择弹层。 */
export class SelectDialog extends Container {
  private list: SelectList;
  private readonly search?: Input;
  private readonly listContainer = new Container();

  get focused(): boolean { return this.search?.focused ?? false; }
  set focused(value: boolean) { if (this.search) this.search.focused = value; }

  constructor(private readonly options: {
    title: string;
    hint?: string;
    items: SelectItem[];
    selectedIndex?: number;
    maxVisible?: number;
    searchable?: boolean;
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
  }) {
    super();
    this.list = this.createList(options.items);
    this.list.setSelectedIndex(options.selectedIndex ?? 0);
    this.addChild(new DialogFrame(options.title, "", "top"));
    if (options.searchable ?? options.items.length > 7) {
      this.search = new Input();
      this.addChild(new Text(theme.fg("muted", "Type to filter by name or description"), 1, 0));
      this.addChild(this.search);
    }
    this.addChild(new Text("", 0, 0));
    this.listContainer.addChild(this.list);
    this.addChild(this.listContainer);
    this.addChild(new DialogFrame("", options.hint ?? "↑↓ navigate · enter select · esc/ctrl+c cancel", "bottom"));
  }

  handleInput(data: string): void {
    if (!this.search || (["up", "down", "enter", "escape", "ctrl+c"] as const).some((key) => matchesKey(data, key))) {
      this.list.handleInput(data);
      return;
    }
    const previous = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue() === previous) return;
    const terms = this.search.getValue().toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const items = this.options.items.filter((item) => {
      const text = `${item.value} ${item.label} ${item.description ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    this.list = this.createList(items);
    this.listContainer.clear();
    this.listContainer.addChild(items.length ? this.list : new Text(theme.fg("muted", "No matches · change the search or press Esc"), 1, 0));
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.options.maxVisible ?? 10, selectListTheme());
    list.onSelect = this.options.onSelect;
    list.onCancel = this.options.onCancel;
    return list;
  }
}

/** 长文本查看弹层：命令输出、报告、审阅结果。 */
export class TextViewerDialog extends Container {
  private scroll = 0;
  private lines: string[] = [];
  private readonly body: Text;

  constructor(
    private readonly title: string,
    content: string,
    private readonly maxRows: number,
    private readonly onClose: () => void
  ) {
    super();
    this.body = new Text("", 1, 0);
    this.lines = content.split("\n");
    this.addChild(new DialogFrame(title, "", "top"));
    this.addChild(this.body);
    this.addChild(new DialogFrame("", "↑↓/pgup/pgdn scroll · esc close", "bottom"));
    this.refresh();
  }

  handleInput(data: string): void {
    // Ctrl+C 也关闭查看器：全局双 Ctrl+C 退出依赖弹层先消费掉第一次按键。
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }
    const page = Math.max(1, this.maxRows - 1);
    if (matchesKey(data, "up")) this.scroll -= 1;
    else if (matchesKey(data, "down")) this.scroll += 1;
    else if (matchesKey(data, "pageUp")) this.scroll -= page;
    else if (matchesKey(data, "pageDown")) this.scroll += page;
    else return;
    this.refresh();
  }

  private refresh(): void {
    const maxScroll = Math.max(0, this.lines.length - this.maxRows);
    this.scroll = Math.min(maxScroll, Math.max(0, this.scroll));
    const visible = this.lines.slice(this.scroll, this.scroll + this.maxRows);
    const suffix = maxScroll > 0
      ? `\n${theme.fg("dim", `${String(this.scroll + visible.length)}/${String(this.lines.length)} lines`)}`
      : "";
    this.body.setText(`${visible.join("\n")}${suffix}`);
  }

  titleText(): string {
    return this.title;
  }
}

/** 权限确认：选项列表 + 强确认输入行。 */
export class PermissionDialog extends Container {
  private selectedIndex = DEFAULT_PERMISSION_SELECTION;
  private confirmation = "";
  private confirmationAttempted = false;
  private denialReason = "";
  private denialReasonAttempted = false;
  private detailsExpanded = false;
  private readonly body: Text;

  constructor(
    private request: TuiPermissionRequest,
    private readonly onAnswer: (choice: PermissionChoice, denialReason?: string) => void,
    private readonly onToggleDetails: () => void,
    private readonly maxBodyLines = Number.POSITIVE_INFINITY
  ) {
    super();
    this.body = new Text("", 1, 0);
    this.addChild(new DialogFrame("需要你的确认", "", "top"));
    this.addChild(this.body);
    this.addChild(new DialogFrame(
      "",
      "↑↓ 选择 · Enter 确认 · Ctrl+O 详情 · Esc 拒绝",
      "bottom"
    ));
    this.refresh();
  }

  setRequest(request: TuiPermissionRequest): void {
    this.request = request;
    this.selectedIndex = DEFAULT_PERMISSION_SELECTION;
    this.confirmation = "";
    this.confirmationAttempted = false;
    this.denialReason = "";
    this.denialReasonAttempted = false;
    this.refresh();
  }

  setDetailsExpanded(expanded: boolean): void {
    this.detailsExpanded = expanded;
    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      this.selectedIndex = movePermissionSelection(this.selectedIndex, -1, this.request.canRemember !== false);
      this.refresh();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = movePermissionSelection(this.selectedIndex, 1, this.request.canRemember !== false);
      this.refresh();
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      this.onToggleDetails();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onAnswer("deny");
      return;
    }
    if (matchesKey(data, "enter")) {
      const choice = confirmedPermissionChoice(this.selectedIndex, this.request.requireFullYes, this.confirmation, this.denialReason);
      if (choice) {
        this.onAnswer(choice, choice === "deny_with_reason" ? this.denialReason.trim() : undefined);
        return;
      }
      if (permissionChoiceAt(this.selectedIndex) === "deny_with_reason") this.denialReasonAttempted = true;
      else this.confirmationAttempted = true;
      this.refresh();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (permissionChoiceAt(this.selectedIndex) === "deny_with_reason") this.denialReason = this.denialReason.slice(0, -1);
      else this.confirmation = this.confirmation.slice(0, -1);
      this.refresh();
      return;
    }
    const choice = permissionChoiceAt(this.selectedIndex);
    // 只有审批动作收确认词，拒绝并说明理由收单行理由；控制键和组合键忽略。
    if (choice === "deny_with_reason" && isPrintableChar(data)) {
      this.denialReason = appendPermissionReason(this.denialReason, data);
      this.refresh();
      return;
    }
    if (this.request.requireFullYes && (choice === "allow_once" || choice === "allow_always") && isPrintableChar(data)) {
      this.confirmation = appendPermissionConfirmation(this.confirmation, data);
      this.refresh();
    }
  }

  private refresh(): void {
    const details: string[] = [];
    const view = permissionPresentation(this.request);
    if (this.request.command) details.push(this.request.command);
    if (this.request.targetPath && !this.request.secondaryTargetPath) details.push(this.request.targetPath);
    if (view.details) details.push(...view.details.split(/\r?\n/u));
    if (view.reason) details.push(view.reason);
    if (this.detailsExpanded && this.request.preview) details.push(...this.request.preview.split(/\r?\n/u));

    const actionLines: string[] = [];
    const selectedChoice = permissionChoiceAt(this.selectedIndex);
    if (this.request.riskLevel === "critical") {
      actionLines.push(theme.fg("error", this.request.canRemember === false ? "此操作按设置需要逐次确认。" : "此操作涉及关键或敏感内容，请核对后确认。"));
    }
    actionLines.push("");
    permissionOptions.forEach((option, index) => {
      if (option.choice === "allow_always" && this.request.canRemember === false) return;
      const selected = index === this.selectedIndex;
      const prefix = selected ? "→ " : "  ";
      const label = `${prefix}${String(index + 1)}. ${option.label}`;
      actionLines.push(
        (selected ? theme.fg("accent", label) : label)
        + theme.fg("muted", `  ${option.description}`)
      );
    });
    if (selectedChoice === "deny_with_reason") {
      actionLines.push("");
      actionLines.push(theme.fg("warning", "输入拒绝理由，再按 Enter 提交。"));
      actionLines.push(`${theme.fg("muted", "> ")}${this.denialReason}${theme.fg("warning", "█")}`);
      if (this.denialReasonAttempted && !this.denialReason.trim()) {
        actionLines.push(theme.fg("error", "请填写拒绝理由。"));
      }
    } else if (this.request.requireFullYes && (selectedChoice === "allow_once" || selectedChoice === "allow_always")) {
      actionLines.push("");
      actionLines.push(theme.fg("warning", "输入 yes，再按 Enter 批准。"));
      actionLines.push(`${theme.fg("muted", "> ")}${this.confirmation}${theme.fg("warning", "█")}`);
      if (this.confirmationAttempted) {
        actionLines.push(theme.fg("error", "请输入完整的 yes。"));
      }
    }

    const detailBudget = Math.max(0, this.maxBodyLines - 1 - actionLines.length);
    const visibleDetails = truncatePermissionDetails(details, detailBudget);
    this.body.setText([
      theme.fg("warning", theme.bold(view.title)),
      ...visibleDetails.map((line) => theme.fg("muted", line)),
      ...actionLines
    ].join("\n"));
  }
}

/** 保留权限动作区，避免长预览把 Enter/yes 提示裁掉。 */
function truncatePermissionDetails(details: string[], maxLines: number): string[] {
  if (details.length <= maxLines) return details;
  if (maxLines <= 0) return [];
  const marker = theme.fg("dim", "… 部分详情已收起，按 Ctrl+O 展开");
  if (maxLines === 1) return [marker];
  return [...details.slice(0, maxLines - 1), marker];
}

/** 单个可打印字符：既不是控制码，也不是多字节的按键序列。 */
function isPrintableChar(data: string): boolean {
  if ([...data].length !== 1) return false;
  const code = data.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}
