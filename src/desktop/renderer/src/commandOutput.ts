import type { TimelineCommand } from "./sessionTimeline.js";

type CommandOutput = Pick<TimelineCommand, "stdout" | "stderr">;

const PREVIEW_CHARACTERS_PER_STREAM = 16_384;

export function commandOutputText({ stdout, stderr }: CommandOutput): string {
  return [stdout, stderr].filter(Boolean).join(stdout.endsWith("\n") ? "" : "\n");
}

export function commandOutputPreview(command: CommandOutput): { text: string; truncated: boolean } {
  const truncated = command.stdout.length > PREVIEW_CHARACTERS_PER_STREAM || command.stderr.length > PREVIEW_CHARACTERS_PER_STREAM;
  return {
    text: commandOutputText({ stdout: previewTail(command.stdout), stderr: previewTail(command.stderr) }),
    truncated
  };
}

function previewTail(text: string): string {
  if (text.length <= PREVIEW_CHARACTERS_PER_STREAM) return text;
  let start = text.length - PREVIEW_CHARACTERS_PER_STREAM;
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  return `…\n${text.slice(start)}`;
}
