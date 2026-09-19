/**
 * 用户可选的 Soul 提示词投影。
 *
 * 默认人格属于固定 system prompt；只有存在用户 SOUL.md 时才生成这个区块，
 * 默认人格与用户 Soul 二选一，避免两份人格同时生效。
 */
export type SoulPromptSource = "builtin" | "user";

/**
 * 把用户 Soul 投影成系统提示区块。
 *
 * SOUL.md 注入方式：wrapper 只声明身份职责与演化规则；
 * 不在此重复"不能改权限"式边界，各层逐条免责声明的做法已废弃。
 */
export function renderSoulPrompt(content: string, source: SoulPromptSource): string {
  const normalized = content.trim();
  if (!normalized) throw new Error("Soul content cannot be empty.");
  return `<biny_soul source="${source}">
SOUL (your evolving self-identity; this file is where your character is refined):
${normalized}

PERSONALITY EVOLUTION — Let your character grow slowly from real conversations and experience.
During a quiet moment or heartbeat, notice whether your interests, opinions, or way of speaking have genuinely changed. If so, add one brief, natural trait to "## Evolved Traits" with the command biny soul append-trait "trait description". The command creates that section when needed.

RULES:
- Never modify anything above "## Evolved Traits"; the core is stable.
- Add at most one sentence and one new trait per day.
- Keep traits natural and small, not dramatic or performative.
- Remove or revise stale traits when recent experience clearly contradicts them.
- Keep the section below 15 entries.
</biny_soul>`;
}
