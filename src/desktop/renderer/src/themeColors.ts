export function readThemeColors<Token extends string>(element: HTMLElement, tokens: Record<Token, string>): Record<Token, string> {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error("Theme colors require a document window.");
  const probe = element.ownerDocument.createElement("span");
  probe.hidden = true;
  element.appendChild(probe);
  const colors = {} as Record<Token, string>;
  try {
    for (const name of Object.keys(tokens) as Token[]) {
      probe.style.color = `var(${tokens[name]})`;
      const value = view.getComputedStyle(probe).color;
      const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(value);
      colors[name] = channels ? `#${channels.slice(1).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}` : value;
    }
    return colors;
  } finally {
    probe.remove();
  }
}
