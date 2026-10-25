import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

export const maxSearchQueryBytes = 64 * 1024;
const maxOutputBytes = 8 * 1024 * 1024;
let activeProcesses = 0;

export class RipgrepError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RipgrepError";
  }
}

export interface RipgrepMatch {
  line: number;
  column: number;
  text: string;
}

export async function searchRipgrepFiles(options: {
  query: string;
  mode: "literal" | "regex";
  caseSensitive: boolean;
  workspaceRoot: string;
  files: readonly string[];
  maxMatches: number;
  signal?: AbortSignal;
}): Promise<Map<string, RipgrepMatch[]>> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (activeProcesses >= 8) throw new RipgrepError("Search process limit reached; retry after another search finishes.");
  const nativeFiles = new Map(options.files.map((file) => [`./${file}`, file]));
  const args = ["--no-config", "--json", "--no-ignore", "--hidden", "--no-follow", "--text", "--crlf", "--color", "never",
    "--max-count", String(options.maxMatches),
    ...(options.mode === "literal" ? ["--fixed-strings"] : []), ...(options.caseSensitive ? ["--case-sensitive"] : ["--ignore-case"]),
    "--regexp", options.query, "--", ...(nativeFiles.size ? nativeFiles.keys() : ["-"])];
  const child = spawn(rgPath.replace(/\.asar([/\\])/u, ".asar.unpacked$1"), args, { cwd: options.workspaceRoot, env: {}, windowsHide: true });
  activeProcesses += 1;
  let failure: unknown;
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  const fail = (error: unknown): void => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const onAbort = (): void => fail(signal?.reason ?? new DOMException("Search cancelled.", "AbortError"));
  const timer = setTimeout(() => fail(new RipgrepError("ripgrep search timed out.")), 10_000);
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    bytes += Buffer.byteLength(data);
    if (bytes > maxOutputBytes) fail(new RipgrepError("ripgrep output exceeds its 8 MiB limit; narrow the query."));
    else stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(0, 16_384); });
  child.on("error", (error) => fail(new RipgrepError("Bundled ripgrep could not start.", { cause: error })));
  child.stdin.end();
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
      if (signal?.aborted) onAbort();
    });
    if (failure) throw failure;
    signal?.throwIfAborted();
    if (code !== 0 && code !== 1) throw new RipgrepError(stderr.trim() || `ripgrep exited with code ${String(code)}.`);
    const matches = new Map<string, RipgrepMatch[]>();
    for (const row of stdout.split("\n")) {
      if (!row) continue;
      const message = JSON.parse(row) as { type: string; data: {
        path?: { text?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: Array<{ start: number }>;
      } };
      if (message.type !== "match") continue;
      const file = nativeFiles.get(message.data.path?.text ?? "");
      const rawBytes = message.data.lines?.text !== undefined ? Buffer.from(message.data.lines.text)
        : message.data.lines?.bytes === undefined ? undefined : Buffer.from(message.data.lines.bytes, "base64");
      const start = message.data.submatches?.[0]?.start;
      const line = message.data.line_number;
      if (!file || rawBytes === undefined || start === undefined || !Number.isSafeInteger(start)
        || start < 0 || start > rawBytes.length || line === undefined || !Number.isSafeInteger(line) || line < 1) {
        throw new RipgrepError("ripgrep returned an invalid match.");
      }
      const raw = rawBytes.toString("utf8");
      const text = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/u, "") : raw;
      const entry = { line, column: rawBytes.subarray(0, start).toString("utf8").length + 1, text };
      const found = matches.get(file);
      if (found) found.push(entry);
      else matches.set(file, [entry]);
    }
    return matches;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    activeProcesses -= 1;
  }
}
