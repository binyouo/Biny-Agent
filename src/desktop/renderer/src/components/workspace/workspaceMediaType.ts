export type WorkspaceMediaKind = "video" | "audio";
const videoExtensions = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v", "ogv", "mpeg", "mpg"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "wma", "aif", "aiff", "opus"]);

export function workspaceMediaKind(path: string): WorkspaceMediaKind | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return videoExtensions.has(extension) ? "video" : audioExtensions.has(extension) ? "audio" : undefined;
}
