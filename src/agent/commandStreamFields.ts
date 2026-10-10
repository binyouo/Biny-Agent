import type { ShellOutputExcerpt } from "./shellOutputProjection.js";

export function commandStreamFields(stream: "stdout" | "stderr", record: Record<string, unknown>, excerpt: ShellOutputExcerpt): Record<string, unknown> {
  const capturedBytes = numberField(record, `${stream}RetainedBytes`) ?? Buffer.byteLength(stringField(record, stream), "utf8");
  const bytes = numberField(record, `${stream}Bytes`) ?? capturedBytes;
  // New captures count discarded decoded UTF-8 text; old records only have raw-byte estimates.
  const explicitOmittedBytes = numberField(record, `${stream}CaptureOmittedBytes`);
  const captureTruncated = record[`${stream}Truncated`] === true;
  const projectionTruncated = excerpt.omittedBytes > 0;
  return {
    [stream]: excerpt.text || undefined,
    [`${stream}Bytes`]: bytes,
    [`${stream}RetainedBytes`]: Buffer.byteLength(excerpt.text, "utf8"),
    [`${stream}Truncated`]: captureTruncated || projectionTruncated,
    [`${stream}TruncationDirection`]: projectionTruncated ? "head_and_tail" : captureTruncated ? "tail" : undefined,
    [`${stream}CaptureTruncated`]: captureTruncated,
    [`${stream}CaptureOmittedBytes`]: explicitOmittedBytes === undefined
      ? captureTruncated ? Math.max(0, bytes - capturedBytes) : 0
      : Math.max(0, explicitOmittedBytes),
    [`${stream}ProjectionTruncated`]: projectionTruncated,
    [`${stream}ProjectionOmittedBytes`]: excerpt.omittedBytes
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] as string : "";
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
}
