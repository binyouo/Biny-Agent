/** 输入装饰的纯计算：镜像坐标映射、同行拖尾与技能标签范围，不修改草稿协议。 */
export interface CaretPosition { x: number; y: number; height: number }
interface Point { left: number; top: number }

/** 组合区可能暂时是选区，装饰光标跟随其尾端；普通选区不显示装饰光标。 */
export function promptCaretOffset(start: number, end: number, composing: boolean): number | undefined {
  return start === end || composing ? end : undefined;
}

export function promptCaretPosition(
  input: Point & { width: number; height: number },
  host: Point,
  mirror: Point,
  measured: Point & { height: number },
  scroll: { left: number; top: number }
): CaretPosition | undefined {
  const x = measured.left - mirror.left - scroll.left;
  const y = measured.top - mirror.top - scroll.top;
  const height = measured.height;
  if (![x, y, height].every(Number.isFinite) || measured.height <= 0
    || x < 0 || x > input.width || y < 0 || y + height > input.height) return undefined;
  return { x: input.left - host.left + x, y: input.top - host.top + y, height };
}

export function promptCaretMotion(previous: CaretPosition | undefined, next: CaretPosition): {
  snap: boolean;
  trail?: { left: number; width: number; direction: "left" | "right" };
} {
  const snap = !previous || Math.abs(previous.y - next.y) >= 0.5;
  if (snap || !previous || Math.abs(next.x - previous.x) < 2) return { snap };
  const width = Math.min(96, Math.abs(next.x - previous.x));
  return { snap, trail: { left: next.x > previous.x ? next.x - width : next.x, width, direction: next.x > previous.x ? "right" : "left" } };
}

export interface PromptSkillToken { start: number; end: number; name: string }

export function promptSkillTokens(value: string, skills: readonly { name: string }[]): PromptSkillToken[] {
  const names = new Set(skills.map((skill) => skill.name));
  return [...value.matchAll(/(?:^|\s)(\/skills:([^\s]+))/gu)].flatMap((match) => {
    const name = match[2] ?? "";
    const text = match[1] ?? "";
    const start = match.index + match[0].length - text.length;
    return names.has(name) ? [{ start, end: start + text.length, name }] : [];
  });
}

/** 只在标签边缘整体删除；选区、标签内部、未知技能仍交给原生编辑。 */
export function promptSkillDeletion(value: string, start: number, end: number, key: string, tokens: readonly PromptSkillToken[]): { start: number; end: number } | undefined {
  if (start !== end) return undefined;
  for (const token of tokens) {
    const afterSpace = token.end + (value[token.end] === " " ? 1 : 0);
    if (key === "Backspace" && (start === token.end || start === afterSpace)) return { start: token.start, end: start };
    if (key === "Delete" && start === token.start) return { start, end: afterSpace };
  }
  return undefined;
}
