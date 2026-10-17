import morphdomSource from "morphdom/dist/morphdom-umd.min.js?raw";
import { createWidgetDocument, type WidgetTheme } from "../../../../widgets/document.js";

export function loadWidgetDocument(token: string, theme: WidgetTheme): string {
  return createWidgetDocument({ token, morphdomSource, theme });
}
