/** Model-only shell excerpts. The capture and Code Mode budgets are independent. */
export const shellOutputBudgetBytes = 12 * 1024;

export interface ShellOutputExcerpt {
  text: string;
  /** Source bytes retained, excluding the omission marker. */
  retainedContentBytes: number;
  omittedBytes: number;
}

/** Share one UTF-8 budget fairly; a short stream lends its unused half to the other. */
export function projectShellStreams(stdout: string, stderr: string): { stdout: ShellOutputExcerpt; stderr: ShellOutputExcerpt } {
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  const stderrBytes = Buffer.byteLength(stderr, "utf8");
  const half = shellOutputBudgetBytes / 2;
  const stdoutBudget = stdoutBytes <= half ? stdoutBytes
    : stderrBytes <= half ? shellOutputBudgetBytes - stderrBytes : half;
  return {
    stdout: shellOutputExcerpt(stdout, stdoutBudget),
    stderr: shellOutputExcerpt(stderr, shellOutputBudgetBytes - stdoutBudget)
  };
}

/** The marker counts towards maxBytes; cuts never split a UTF-8 code point. */
export function shellOutputExcerpt(value: string, maxBytes = shellOutputBudgetBytes): ShellOutputExcerpt {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, retainedContentBytes: bytes, omittedBytes: 0 };
  // Reserving the largest possible byte count keeps the final marker bounded too.
  const available = Math.max(0, maxBytes - Buffer.byteLength(omissionMarker(bytes), "utf8"));
  const buffer = Buffer.from(value, "utf8");
  let headEnd = Math.floor(available / 2);
  while (headEnd > 0 && isContinuation(buffer[headEnd]!)) headEnd -= 1;
  let tailStart = buffer.length - (available - Math.floor(available / 2));
  while (tailStart < buffer.length && isContinuation(buffer[tailStart]!)) tailStart += 1;
  const retainedContentBytes = headEnd + buffer.length - tailStart;
  const omittedBytes = bytes - retainedContentBytes;
  const marker = omissionMarker(omittedBytes);
  // Tiny budgets are useful to callers too; metadata still reports the omission.
  const text = Buffer.byteLength(marker, "utf8") > maxBytes ? ""
    : `${buffer.subarray(0, headEnd).toString("utf8")}${marker}${buffer.subarray(tailStart).toString("utf8")}`;
  return { text, retainedContentBytes, omittedBytes };
}

function omissionMarker(bytes: number): string {
  return `\n... [${String(bytes)} UTF-8 bytes omitted] ...\n`;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
