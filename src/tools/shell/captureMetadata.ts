/** Both counters describe decoded text in UTF-8, never raw process input. */
export function captureMetadata(decodedBytes: number, retainedBytes: number): { omittedBytes: number; truncated: boolean } {
  const omittedBytes = Math.max(0, decodedBytes - retainedBytes);
  return { omittedBytes, truncated: omittedBytes > 0 };
}
