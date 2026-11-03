/** CDP keeps DOM key, physical code and Windows virtual key code separate. */
export interface BrowserKeyDescriptor {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  /** Key-down text only; callers suppress it when modifiers are active. */
  text?: string;
}

const namedKeys: Readonly<Record<string, readonly [number, string]>> = {
  Backspace: [8, "Backspace"],
  Tab: [9, "Tab"],
  Enter: [13, "Enter"],
  Escape: [27, "Escape"],
  " ": [32, "Space"],
  PageUp: [33, "PageUp"],
  PageDown: [34, "PageDown"],
  End: [35, "End"],
  Home: [36, "Home"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  Insert: [45, "Insert"],
  Delete: [46, "Delete"]
};

/** Preserve unknown keys and text; do not guess a physical key for Unicode. */
export function describeBrowserKey(key: string): BrowserKeyDescriptor {
  const named = Object.hasOwn(namedKeys, key) ? namedKeys[key] : undefined;
  const letter = /^[A-Za-z]$/u.test(key) ? key.toUpperCase() : undefined;
  const identity = named
    ? { windowsVirtualKeyCode: named[0], code: named[1] }
    : letter ? { windowsVirtualKeyCode: letter.charCodeAt(0), code: `Key${letter}` } : {};
  return { key, ...identity, text: key === "Enter" ? "\r" : key.length === 1 ? key : undefined };
}
