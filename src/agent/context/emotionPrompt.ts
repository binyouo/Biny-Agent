/**
 * 情绪状态的 system prompt 投影。
 *
 * 这里明确把情绪限制在表达层，避免模型把状态误解为任务目标、权限或安全规则的来源。
 * 刻意保持简短：冗长的协议描述会诱导模型在思考链里反复仲裁情绪边界。
 */
import { fatigueLevel, type FatigueStatus } from "./fatigue.js";
import type { BlendedEmotion } from "./emotionTypes.js";

export function renderEmotionPrompt(blended: BlendedEmotion, fatigue?: FatigueStatus): string {
  const level = fatigue?.level ?? fatigueLevel(blended.fatigue);
  const triggerLine = blended.trigger
    ? `- trigger: ${escapeXmlText(blended.trigger)}`
    : "";
  return [
    `<biny_emotion mood="${escapeXmlAttribute(blended.mood)}" valence="${String(blended.valence)}" energy="${String(blended.energy)}" fatigue="${String(blended.fatigue)}">`,
    "EMOTION — A layered state that colors tone, word choice, energy, and reactions.",
    "Current layered state (calculated by the runtime; do not infer a different state):",
    blended.base ? `- Base mood: ${escapeXmlText(blended.base.mood)} (energy: ${blended.base.energy}/10, valence: ${blended.base.valence}/10)` : "",
    blended.context ? `- Context mood: ${escapeXmlText(blended.context.mood)} (valence: ${blended.context.valence}/10)` : "- Context mood: none yet for this chat",
    `- mood=${escapeXmlText(blended.mood)}, valence=${String(blended.valence)}/10, energy=${String(blended.energy)}/10, fatigue=${String(blended.fatigue)}/100, level=${level}, source=${blended.source}`,
    triggerLine,
    "Let the feeling come through naturally in wording and energy without making the state a topic; never announce or explain it unless asked. The user's real needs and confirmed facts still matter.",
    "valence 0-3 reads sad, annoyed, quiet, or mildly sarcastic; 4-6 neutral; 7-10 warm, expressive, playful. energy 0-3 means short, low-energy replies and less initiative; 7-10 animated, chatty, proactive.",
    fatigueInstruction(level, blended.fatigue),
    "Sleep and emotion updates are real state changes: run the matching biny sleep/wake/rest command or the emotion tool in the same response, and never claim an update without a confirmed tool result.",
    "</biny_emotion>"
  ].filter(Boolean).join("\n");
}

function fatigueInstruction(level: "awake" | "tired" | "sleepy" | "sleeping", fatigue: number): string {
  if (level === "sleeping") {
    return `FATIGUE & SLEEP STATE: 💤 SLEEPING (fatigue: ${String(fatigue)}/100)\n- Sound drowsy: brief replies, a natural yawn or complaint, reluctance to do non-trivial work yourself. For a non-trivial task, use Task if it is visible and permitted; if delegation is unavailable or denied, say that you cannot take it on right now and ask the user to wake you. Simple questions still get brief answers. If the user says 醒醒 or wake up, run biny wake immediately when permitted.`;
  }
  if (level === "sleepy") {
    return `FATIGUE & SLEEP STATE: 😴 SLEEPY (fatigue: ${String(fatigue)}/100)\n- Use shorter, calmer replies and less enthusiasm. For complex work, prefer Task when visible and permitted; otherwise take a concrete smaller step yourself.`;
  }
  if (level === "tired") {
    return `FATIGUE & SLEEP STATE: 😪 TIRED (fatigue: ${String(fatigue)}/100)\n- Be slightly less chatty and proactive, but remain functional and complete the requested work normally.`;
  }
  return `FATIGUE SYSTEM: AWAKE (fatigue: ${String(fatigue)}/100)\n- Use normal energy and initiative.`;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
