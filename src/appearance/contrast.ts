function channels(hex: string): number[] {
  return [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(hex: string): number {
  return channels(hex).reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
}

export function readableCommentColor(foreground: string, background: string, dark: boolean): string {
  let color = foreground;
  const backgroundLuminance = luminance(background);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const foregroundLuminance = luminance(color);
    if ((Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05) >= 3.5) break;
    color = `#${channels(color).map(channel => Math.round(dark ? channel + (255 - channel) * 0.15 : channel * 0.85).toString(16).padStart(2, "0")).join("")}`;
  }
  return color;
}
