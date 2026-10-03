import engineSource from "@strudel/web/dist/index.js?raw";
import playerSource from "./pattern-player.js?raw";
import themeCss from "./styles/theme.css?raw";
import playerCss from "./styles/markdown-pattern.css?raw";
import { createPatternPlayerDocument } from "./patternPlayer.js";

export function loadPatternPlayerDocument(token: string): string {
  return createPatternPlayerDocument({ engineSource, playerSource, css: `${themeCss}\n${playerCss}`, token });
}
