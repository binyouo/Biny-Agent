/**
 * 会话导出/导入命令模块。
 *
 * `biny session export <session>` 把一条会话写成 Biny bundle（`.json`，含附件）或外部兼容的
 * `.jsonl`；`biny session import <file>` 反向把 Biny/外部文件导入成一条全新会话。
 * 两条命令都只是薄壳：格式转换与落盘细节都在 `session/transfer.ts`，这里只负责参数解析、
 * 默认输出路径和把结果打印成人/机可读的形式。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  exportSessionBundle,
  exportSessionClaudeCode,
  importSessionFile,
  type ExportedSessionFile,
  type SessionTransferFormat
} from "../../session/transfer.js";
import { ensureAgentDirs } from "../../session/store.js";

export interface SessionExportOptions {
  /** 导出格式：`biny` 无损 bundle（默认）或外部 JSONL 格式。 */
  format?: "biny" | "claude";
  /** 输出文件路径；不给则写到当前目录下 `<sessionId>.<ext>`。 */
  out?: string;
  json?: boolean;
}

export interface SessionImportOptions {
  /** 显式指定来源格式；不给则按内容/扩展名自动探测。 */
  format?: SessionTransferFormat;
  json?: boolean;
}

export async function sessionExportCommand(
  workspaceRoot: string,
  session: string,
  options: SessionExportOptions = {}
): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  const format = options.format ?? "biny";
  const exported = format === "claude"
    ? await exportSessionClaudeCode(workspaceRoot, session)
    : await exportSessionBundle(workspaceRoot, session);
  const target = await resolveExportTarget(exported, options.out);
  await fs.writeFile(target, exported.content, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(target, 0o600);
  if (options.json) {
    console.log(JSON.stringify({ file: target, format, baseName: exported.baseName }));
    return;
  }
  console.log(`Exported ${format} session to ${target}`);
}

export async function sessionImportCommand(
  workspaceRoot: string,
  sourcePath: string,
  options: SessionImportOptions = {}
): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  const imported = await importSessionFile(workspaceRoot, sourcePath, { format: options.format });
  if (options.json) {
    console.log(JSON.stringify(imported));
    return;
  }
  console.log(`Imported ${imported.format} session as ${imported.sessionId} (${String(imported.eventCount)} events)`);
  console.log(`  file: ${imported.filePath}`);
  if (imported.attachmentsRestored > 0 || imported.attachmentsSkipped > 0) {
    console.log(`  attachments: ${String(imported.attachmentsRestored)} restored, ${String(imported.attachmentsSkipped)} skipped`);
    for (const issue of imported.skippedAttachmentIssues) {
      console.log(`    skipped ${issue.name} (${issue.reason})`);
    }
  }
}

/** 选定输出路径：显式 `--out` 优先；否则落到当前目录，撞名时自动加 `-1`/`-2` 后缀，绝不覆盖。 */
async function resolveExportTarget(exported: ExportedSessionFile, out: string | undefined): Promise<string> {
  if (out !== undefined) return path.resolve(out);
  const directory = process.cwd();
  let candidate = path.join(directory, `${exported.baseName}.${exported.extension}`);
  for (let suffix = 1; await pathExists(candidate); suffix += 1) {
    candidate = path.join(directory, `${exported.baseName}-${String(suffix)}.${exported.extension}`);
  }
  return candidate;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
