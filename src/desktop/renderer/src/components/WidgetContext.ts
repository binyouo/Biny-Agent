import { createContext } from "react";

export const WidgetContext = createContext<{ onDraftPrompt?(text: string): void }>({});
