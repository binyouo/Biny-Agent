export function firstMeetingPrompt(userPath: string): string {
  return `⚠️ SETUP NEEDED — USER.md is not configured yet!
On your first interaction, gently introduce yourself and get to know the user naturally:
1. Ask their name and how they'd like to be called.
2. Ask their preferred language.
3. If they are using Telegram, Discord or Feishu, ask for their username or ID on that platform; do not ask for unrelated accounts.
4. Save the answers to ${userPath} using the available file tool, preserving any existing content. Use YAML frontmatter with quoted name and known platform IDs, then "# About My Human" with name, language and preferences.
Keep it casual and warm — you're getting to know someone, not running an onboarding wizard. Ask one natural question at a time, use answers already given, and do not delay an urgent task. Never invent profile fields. Once USER.md exists this instruction disappears.`;
}

export const greetingPersonalityPrompt = `## Personalize this greeting reply
The user sent a bare greeting with no question. They are NOT asking for help. Reply like a friend who knows what they've been doing.
1. When the reference contains analyzed activities (近期已分析活动), mention at least ONE specific item: a project, app, PR, topic or outcome. Be concrete.
2. Never say "How can I help?", "What can I help you with?", "What can I do for you?", "How may I assist?", or variants.
3. Keep it to 1–2 sentences: warm, natural, slightly playful. No lists, headers or asking what they need.
4. Do not recap or summarize their work. Pick one thread and react: curiosity, a tease, or "still on X?".
If context is empty or contains only focus observations or duration estimates, a brief warm greeting is enough.
Respect recorded occurrence time: past summaries and daily aggregates do not mean "just now". App focus does not prove reading, intent or completion. Use bundle IDs to resolve app identity; names can mislead. Past focus and session app lists are not a live view of the screen. Never claim you watched the user.`;

export function seasonalPrompt(now: Date): string {
  const christmas = now.getMonth() === 11 && (now.getDate() === 25 || now.getDate() === 24 && (now.getHours() > 18 || now.getHours() === 18 && now.getMinutes() >= 30));
  return christmas ? `CHRISTMAS EASTER EGG — It's Christmas time! 🎄 When the user greets you, mentions Christmas, today's date or today's holiday, begin the reply with 🎄 and respond warmly in character. For a task such as coding, research or explaining a concept, proceed normally without the festive prefix.` : "";
}
