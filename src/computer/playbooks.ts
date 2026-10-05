import { readFileSync } from "node:fs";
import path from "node:path";
import { builtinSkillRoot } from "../extensions/builtinSkills.js";

const applications: Record<string, string> = {
  "com.apple.Music": "AppleMusic", "com.spotify.client": "Spotify",
  "com.netease.163music": "NetEaseMusic", "notion.id": "Notion",
  "com.apple.iWork.Numbers": "Numbers", "com.apple.Clock": "Clock",
  "com.apple.ScreenContinuity": "IPhoneMirroring"
};
/** 只允许随包发布的说明书；应用返回值不能指定文件路径。 */
export function applicationPlaybook(bundle: unknown): string {
  const name = typeof bundle === "string" ? applications[bundle] : undefined;
  if (!name) return "";
  try { return readFileSync(path.join(builtinSkillRoot(), "computer-use", "playbooks", `${name}.md`), "utf8"); }
  catch { return ""; }
}
