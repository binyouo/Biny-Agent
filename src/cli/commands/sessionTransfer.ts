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
  conversationId?: string;
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
  const target = await writeExportFile(exported, options.out);
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
  const imported = await importSessionFile(workspaceRoot, sourcePath, { format: options.format, conversationId: options.conversationId });
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

/** 显式 `--out` 写入指定路径；默认文件名以独占创建选定，撞名时加后缀，绝不覆盖。 */
async function writeExportFile(exported: ExportedSessionFile, out: string | undefined): Promise<string> {
  const directory = process.cwd();
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const name = suffix === 0 ? exported.baseName : `${exported.baseName}-${String(suffix)}`;
    const target = out === undefined ? path.join(directory, `${name}.${exported.extension}`) : path.resolve(out);
    try {
      await fs.writeFile(target, exported.content, { encoding: "utf8", mode: 0o600, flag: out === undefined ? "wx" : "w" });
      return target;
    } catch (error) {
      if (out === undefined && typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Cannot export session: all 1,000 default filenames are occupied. Use --out to choose an output path.");
}
