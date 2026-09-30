let skinStyles: Promise<unknown> | undefined;
export function loadSkinStyles(): Promise<unknown> {
  skinStyles ??= import("./styles/retro-entry.css").catch((error: unknown) => { skinStyles = undefined; throw error; });
  return skinStyles;
}
