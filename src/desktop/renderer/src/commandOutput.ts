import type { TimelineCommand } from "./sessionTimeline.js";
import type { ToolUpdate } from "../../../tools/types.js";

type CommandOutput = Pick<TimelineCommand, "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated">;

const PREVIEW_CHARACTERS_PER_STREAM = 16_384;

export function commandOutputText(command: CommandOutput, updates?: readonly ToolUpdate[]): string {
  let { stdout, stderr } = command;
  // 实时原始片段已由工具持有，只在复制时还原被展示裁剪的流。
  if (updates && command.stdoutTruncated) stdout = updates.filter(update => update.kind === "stdout").map(update => update.text ?? "").join("");
  if (updates && command.stderrTruncated) stderr = updates.filter(update => update.kind === "stderr").map(update => update.text ?? "").join("");
  return [stdout, stderr].filter(Boolean).join(stdout.endsWith("\n") ? "" : "\n");
}

export function appendCommandOutput(command: CommandOutput, stream: "stdout" | "stderr", text: string): void {
  if (command[stream].length + text.length > PREVIEW_CHARACTERS_PER_STREAM) command[`${stream}Truncated`] = true;
  command[stream] = previewTail(command[stream] + text);
}

export function commandOutputPreview(command: CommandOutput): { text: string; truncated: boolean } {
  const stdoutTruncated = command.stdoutTruncated || command.stdout.length > PREVIEW_CHARACTERS_PER_STREAM;
  const stderrTruncated = command.stderrTruncated || command.stderr.length > PREVIEW_CHARACTERS_PER_STREAM;
  return {
    text: commandOutputText({
      stdout: `${stdoutTruncated ? "…\n" : ""}${previewTail(command.stdout)}`,
      stderr: `${stderrTruncated ? "…\n" : ""}${previewTail(command.stderr)}`
    }),
    truncated: stdoutTruncated || stderrTruncated
  };
}

function previewTail(text: string): string {
  if (text.length <= PREVIEW_CHARACTERS_PER_STREAM) return text;
  let start = text.length - PREVIEW_CHARACTERS_PER_STREAM;
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  return text.slice(start);
}
