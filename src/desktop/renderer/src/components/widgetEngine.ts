import morphdomSource from "morphdom/dist/morphdom-umd.min.js?raw";
import { createWidgetDocument } from "../../../../widgets/document.js";

export function loadWidgetDocument(token: string): string {
  return createWidgetDocument({ token, morphdomSource });
}
