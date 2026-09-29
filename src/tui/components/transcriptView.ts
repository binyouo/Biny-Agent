/**
 * Transcript 容器。
 *
 * reducer 仍是状态来源，这里只把状态增量同步到组件树：按条目 id 复用已有组件，
 * 只对变化的条目调用 update，避免每次 token 都重建整棵子树。
 */
import { Container } from "@earendil-works/pi-tui";
import { CardComponent } from "./cards.js";
import {
  AssistantMessageComponent,
  ActivitySummaryComponent,
  NoticeComponent,
  ThinkingComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type TranscriptItemComponent
} from "./messages.js";
import type { TranscriptItem, TranscriptState } from "../types.js";

export class TranscriptView extends Container {
  private readonly components = new Map<string, TranscriptItemComponent>();
  private readonly lastItems = new Map<string, TranscriptItem>();

  override invalidate(): void {
    // 一些组件保存已着色的文本；切换主题时同时更新文本，保留展开等本地状态。
    for (const [id, component] of this.components) {
      const item = this.lastItems.get(id);
      if (item) component.update(item);
    }
    super.invalidate();
  }

  /** 把最新状态同步进组件树，返回是否有实际变化。 */
  sync(transcript: TranscriptState): boolean {
    const items = [...transcript.committed, ...transcript.active];
    const seen = new Set<string>();
    let changed = false;

    const ordered: TranscriptItemComponent[] = [];
    for (const item of items) {
      seen.add(item.id);
      const existing = this.components.get(item.id);
      if (existing) {
        // 条目对象不可变，身份没变就说明内容没变。
        if (this.lastItems.get(item.id) !== item) {
          existing.update(item);
          this.lastItems.set(item.id, item);
          changed = true;
        }
        ordered.push(existing);
        continue;
      }
      const created = createItemComponent(item);
      if (!created) continue;
      this.components.set(item.id, created);
      this.lastItems.set(item.id, item);
      ordered.push(created);
      changed = true;
    }

    for (const id of [...this.components.keys()]) {
      if (seen.has(id)) continue;
      this.components.delete(id);
      this.lastItems.delete(id);
      changed = true;
    }

    if (changed || ordered.length !== this.children.length) {
      this.children = ordered;
      changed = true;
    }
    return changed;
  }

  /** 取某个条目的组件，用于展开/折叠这类局部交互。 */
  componentFor(itemId: string): TranscriptItemComponent | undefined {
    return this.components.get(itemId);
  }

  reset(): void {
    this.components.clear();
    this.lastItems.clear();
    this.children = [];
  }
}

function createItemComponent(item: TranscriptItem): TranscriptItemComponent | undefined {
  if (item.kind === "user") return new UserMessageComponent(item);
  if (item.kind === "assistant") return new AssistantMessageComponent(item);
  if (item.kind === "activity") return new ActivitySummaryComponent(item);
  // 思考只保留状态行，完整 reasoning 不进入 TUI 主界面。
  if (item.kind === "reasoning") return new ThinkingComponent(item);
  if (item.kind === "tool") return new ToolExecutionComponent(item);
  if (item.kind === "card") return new CardComponent(item);
  return new NoticeComponent(item);
}
