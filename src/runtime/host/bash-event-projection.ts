import { commandStreamFields } from "../../agent/commandStreamFields.js";
import { projectShellStreams } from "../../agent/shellOutputProjection.js";
import { encodeHostFrame, runtimeHostMaxFrameBytes, type HostEventFrame } from "./protocol.js";

/**
 * Only the wire view changes. Capture, model results, session records and the
 * Host's replay journal keep their independent output/archiving contracts.
 * In particular, a wire excerpt neither creates nor promises an archive.
 *
 * The existing 12 KiB shared UTF-8 excerpt budget leaves ample room for JSON
 * escaping (up to six bytes per retained byte). Check the complete JSONL frame
 * before returning it; snapshots, other tools and unrelated oversized metadata
 * are deliberately not truncated here.
 */
export function projectBashEventFrameForTransport(frame: HostEventFrame): HostEventFrame {
  const event = frame.update.event;
  if (!event || (event.type !== "tool.completed" && event.type !== "tool.failed") || event.tool !== "Bash") return frame;
  const result = event.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return frame;
  const record = result as Record<string, unknown>;
  if (record.background === true || typeof record.stdout !== "string" || typeof record.stderr !== "string") return frame;
  // Ordinary results retain their exact shape and bytes, including on replay.
  if (Buffer.byteLength(encodeHostFrame(frame), "utf8") <= runtimeHostMaxFrameBytes) return frame;

  const streams = projectShellStreams(record.stdout, record.stderr);
  if (streams.stdout.omittedBytes === 0 && streams.stderr.omittedBytes === 0) return frame;
  const projected: HostEventFrame = {
    ...frame,
    update: {
      ...frame.update,
      event: {
        ...event,
        result: {
          ...record,
          ...commandStreamFields("stdout", record, streams.stdout),
          ...commandStreamFields("stderr", record, streams.stderr),
          transportProjection: "shell_excerpt"
        }
      }
    }
  };
  // Preserve all non-stream fields and genuine archive metadata. If they still
  // exceed the limit, leave rejection to the unchanged bounded socket writer.
  return Buffer.byteLength(encodeHostFrame(projected), "utf8") <= runtimeHostMaxFrameBytes ? projected : frame;
}
