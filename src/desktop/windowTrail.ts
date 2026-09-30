export interface TrailBounds { x: number; y: number; width: number; height: number }

export function sampleWindowTrail(previous: TrailBounds, current: TrailBounds): Array<[number, number]> {
  if (previous.width !== current.width || previous.height !== current.height) return [];
  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  const count = Math.min(128, Math.floor(distance / 6));
  return Array.from({ length: count }, (_, index) => [Math.round(previous.x + (current.x - previous.x) * index / count), Math.round(previous.y + (current.y - previous.y) * index / count)]);
}
