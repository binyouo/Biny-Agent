import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";
import type { AgentConfigStore } from "../config/store.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";
import { importSessionFile, parseSessionImport, parsePreparedChatGptImport, persistImportedSession, SessionImportCleanupError, type ParsedSessionImport } from "../session/transfer.js";
import { ensureAgentDirs } from "../session/store.js";
import { prepareChatGptSource, type PreparedChatGptSource } from "../session/import/chatgpt.js";
import { discoverConfigurationImports, type ConfigurationImportCandidate } from "./configuration.js";
import { applicationImportSources, type ApplicationImportHistory, type ApplicationImportPreview, type ApplicationImportResult, type ApplicationImportSnapshot, type ApplicationImportSource } from "./types.js";

const maxSourceBytes = 64 * 1024 * 1024;
const maxStateBytes = 32 * 1024 * 1024;
const maxItems = 256;
const maxScanEntries = 4_096;
const maxReceipts = 4_096;
const sourceSchema = z.enum(["claude", "codex", "chatgpt"]);
const categorySchema = z.enum(["settings", "mcp", "sessions"]);
const resultSchema = z.object({ id: z.string().max(256), category: categorySchema, label: z.string().max(512),
  status: z.enum(["imported", "skipped", "failed", "unknown"]), detail: z.string().max(2_048).optional(), sessionId: z.string().max(256).optional() });
const historySchema = z.object({ id: z.string().uuid(), source: sourceSchema, label: z.string().max(512), time: z.string(), workspaceRoot: z.string().max(4_096), results: z.array(resultSchema).max(maxItems) });
const itemSchema = z.object({ id: z.string().max(256), category: categorySchema, label: z.string().max(512), detail: z.string().max(2_048),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), digest: z.string().regex(/^[a-f0-9]{64}$/u), sourcePath: z.string().max(4_096).optional(), conversationId: z.string().max(256).optional(), configurationId: z.string().max(256).optional() });
const previewSchema = z.object({ id: z.string().uuid(), source: sourceSchema, label: z.string(), filePath: z.string().max(4_096).optional(), items: z.array(itemSchema).max(maxItems), warnings: z.array(z.string().max(2_048)).max(256) });
const selectionSchema = z.object({ source: sourceSchema, filePath: z.string().max(4_096).optional(), workspaceRoot: z.string().max(4_096), itemIds: z.array(z.string().max(256)).max(maxItems) });
const stateSchema = z.object({ version: z.literal(1), previews: z.array(previewSchema).max(12), history: z.array(historySchema).max(50),
  receipts: z.array(z.object({ key: z.string(), scope: z.string(), status: z.enum(["attempting", "imported", "skipped", "unknown"]), historyId: z.string(), itemId: z.string(), sessionId: z.string().optional() })).max(maxReceipts),
  sync: z.object({ enabled: z.boolean(), selections: z.array(selectionSchema).max(256), lastError: z.string().max(2_048).optional() }) });
type StoredPreview = z.infer<typeof previewSchema>;
type ImportState = z.infer<typeof stateSchema>;
interface ScannedSource { preview: StoredPreview; configurations: Map<string, ConfigurationImportCandidate>; contents: Map<string, Buffer>; preparedChatGpt?: PreparedChatGptSource }

/** Explicit selections own imports; receipts record admission before any destination writes. */
export class ApplicationImportService {
  private readonly configStore: AgentConfigStore;
  private readonly homeDir: string;
  private stateRoot: string;

  constructor(options: { configStore: AgentConfigStore; homeDir?: string; stateRoot?: string }) {
    this.configStore = options.configStore;
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.stateRoot = path.resolve(options.stateRoot ?? path.join(globalConfigDir(), "application-imports"));
  }

  async snapshot(): Promise<ApplicationImportSnapshot> {
    return await this.withState(async (state) => await this.toSnapshot(state));
  }

  async preview(source: ApplicationImportSource, filePath?: string): Promise<ApplicationImportPreview> {
    sourceSchema.parse(source);
    const scanned = await this.scan(source, filePath);
    return await this.withState(async (state) => {
      state.previews = [scanned.preview, ...state.previews].slice(0, 12);
      return publicPreview(scanned.preview);
    });
  }

  async run(options: { previewId: string; itemIds: string[]; workspaceRoot: string }): Promise<ApplicationImportHistory> {
    const workspaceRoot = await canonicalWorkspace(options.workspaceRoot);
    return await this.withState(async (state) => {
      const preview = state.previews.find((entry) => entry.id === options.previewId);
      if (!preview) throw new Error("导入预览已失效，请重新预览。");
      const ids = [...new Set(options.itemIds)];
      if (!ids.length || ids.length > maxItems || ids.some((id) => !preview.items.some((item) => item.id === id))) throw new Error("请选择当前预览中的导入项目。");
      const selection = { source: preview.source, filePath: preview.filePath, workspaceRoot, itemIds: ids };
      const current = state.sync.selections.find((entry) => entry.source === selection.source && entry.filePath === selection.filePath && entry.workspaceRoot === workspaceRoot);
      if (current) current.itemIds = ids;
      else {
        if (state.sync.selections.length >= 256) throw new Error("导入同步选择已达上限。");
        state.sync.selections.push(selection);
      }
      return await this.execute(state, preview, ids, workspaceRoot);
    });
  }

  async setSyncEnabled(enabled: boolean): Promise<ApplicationImportSnapshot> {
    if (typeof enabled !== "boolean") throw new Error("同步设置无效。");
    return await this.withState(async (state) => {
      if (enabled && !state.sync.selections.length) throw new Error("请先选择要同步的来源项目。");
      state.sync.enabled = enabled;
      return await this.toSnapshot(state);
    });
  }

  async configureSyncSelection(options: { previewId: string; itemIds: string[]; workspaceRoot: string }): Promise<ApplicationImportSnapshot> {
    const workspaceRoot = await canonicalWorkspace(options.workspaceRoot);
    return await this.withState(async (state) => {
      const preview = state.previews.find((entry) => entry.id === options.previewId);
      if (!preview) throw new Error("导入预览已失效，请重新预览。");
      const ids = [...new Set(options.itemIds)];
      if (ids.length > maxItems || ids.some((id) => !preview.items.some((item) => item.id === id))) throw new Error("请选择当前预览中的同步项目。");
      state.sync.selections = state.sync.selections.filter((entry) => entry.source !== preview.source || entry.filePath !== preview.filePath || entry.workspaceRoot !== workspaceRoot);
      if (ids.length) {
        if (state.sync.selections.length >= 256) throw new Error("导入同步选择已达上限。");
        state.sync.selections.push({ source: preview.source, filePath: preview.filePath, workspaceRoot, itemIds: ids });
      }
      if (!state.sync.selections.length) state.sync.enabled = false;
      return await this.toSnapshot(state);
    });
  }

  async sync(): Promise<ApplicationImportSnapshot> {
    return await this.withState(async (state) => {
      if (!state.sync.enabled) return await this.toSnapshot(state);
      state.sync.lastError = undefined;
      for (const selection of state.sync.selections) {
        try {
          const workspaceRoot = await canonicalWorkspace(selection.workspaceRoot);
          const scanned = await this.scan(selection.source, selection.filePath);
          // A newly discovered conversation is not authorization to import it.
          const items = scanned.preview.items.filter((item) => selection.itemIds.includes(item.id));
          if (!items.length) { state.sync.lastError = "已选择的来源项目不可用，请重新预览。"; continue; }
          scanned.preview.items = items;
          const history = await this.execute(state, scanned.preview, items.map((item) => item.id), workspaceRoot, scanned);
          if (history.results.some((result) => result.status === "unknown" || result.status === "failed")) state.sync.lastError = "部分同步项目未完成，请查看导入历史。";
        } catch { state.sync.lastError = "同步来源或目标不可用，请重新预览并检查导入历史。"; }
      }
      return await this.toSnapshot(state);
    });
  }

  private async execute(state: ImportState, preview: StoredPreview, ids: string[], workspaceRoot: string, scannedSource?: ScannedSource): Promise<ApplicationImportHistory> {
    const history: ApplicationImportHistory = { id: randomUUID(), source: preview.source, label: preview.label, time: new Date().toISOString(), workspaceRoot, results: [] };
    state.history = [history, ...state.history].slice(0, 50);
    let scanned: ScannedSource | undefined;
    try { scanned = scannedSource ?? await this.scan(preview.source, preview.filePath); } catch { /* Each selected item receives a source-unavailable result. */ }
    for (const id of ids) {
      const selected = preview.items.find((item) => item.id === id)!;
      const result: ApplicationImportResult = { id, category: selected.category, label: selected.label, status: "failed" };
      history.results.push(result);
      const current = scanned?.preview.items.find((item) => item.id === id);
      if (!current || current.sourceHash !== selected.sourceHash) {
        result.detail = "来源已变化或不可用，请重新预览。";
        continue;
      }
      const target = current.category === "sessions" ? workspaceRoot : await canonicalFuturePath(this.configStore.configPath?.() ?? this.stateRoot);
      const scope = digest(`${preview.source}\0${id}\0${target}`);
      const key = digest(`${scope}\0${current.digest}`);
      const uncertain = state.receipts.find((receipt) => receipt.scope === scope && (receipt.status === "unknown" || receipt.status === "attempting"));
      if (uncertain) { result.status = "unknown"; result.detail = "此前写入结果未知，禁止自动重试，请检查目标内容。"; continue; }
      const imported = state.receipts.find((receipt) => receipt.key === key && (receipt.status === "imported" || receipt.status === "skipped"));
      if (imported) { result.status = "skipped"; result.detail = imported.status === "imported" ? "相同内容已导入。" : "相同内容已处理，保留此前跳过结果。"; result.sessionId = imported.sessionId; continue; }
      if (state.receipts.length >= maxReceipts) { result.detail = "导入收据已达上限，请保留历史并检查存储。"; continue; }
      const bytes = current.sourcePath === undefined ? undefined : scanned?.contents.get(current.sourcePath);
      let preparedImport: ParsedSessionImport | undefined;
      try {
        if (current.category === "sessions") {
          if (!bytes || !current.sourcePath) throw new Error("Missing source.");
          if (preview.source === "chatgpt") {
            if (!scanned?.preparedChatGpt) throw new Error("Missing prepared source.");
            preparedImport = parsePreparedChatGptImport(scanned.preparedChatGpt, current.conversationId);
          } else {
            parseSessionImport(bytes.toString("utf8"), current.sourcePath, { format: preview.source, conversationId: current.conversationId });
          }
        }
      } catch { result.detail = "源会话格式无效或没有可导入内容。"; continue; }
      const receipt: ImportState["receipts"][number] = { key, scope, status: "attempting", historyId: history.id, itemId: id };
      state.receipts.push(receipt);
      result.status = "unknown";
      result.detail = "导入已开始，写入结果尚未确认。";
      // If this write fails, no application or session side effect has started.
      await this.writeState(state);
      let stagedPath: string | undefined;
      try {
        if (current.category === "sessions") {
          await ensureAgentDirs(workspaceRoot);
          if (!preparedImport) {
            stagedPath = path.join(this.stateRoot, `session-snapshot-${randomUUID()}.json`);
            await fs.writeFile(stagedPath, bytes!, { flag: "wx", mode: 0o600 });
          }
          const importedSession = preparedImport
            ? await persistImportedSession(workspaceRoot, preparedImport)
            : await importSessionFile(workspaceRoot, stagedPath!, { format: preview.source, conversationId: current.conversationId });
          result.sessionId = importedSession.sessionId;
          receipt.sessionId = importedSession.sessionId;
          result.detail = importedSession.skippedContentCount || importedSession.attachmentsSkipped
            ? `已导入；跳过 ${importedSession.skippedContentCount} 项不支持的内容和 ${importedSession.attachmentsSkipped} 个附件。` : "已导入新会话，源文件保持不变。";
        } else {
          const candidate = scanned?.configurations.get(current.configurationId!);
          if (!candidate) throw new Error("Missing configuration.");
          const applied = await candidate.apply(workspaceRoot, this.configStore);
          result.status = applied.status;
          result.detail = applied.detail ?? (current.category === "mcp" ? "MCP 已导入并保持禁用。" : "设置已导入。");
        }
        if (current.category === "sessions") result.status = "imported";
        receipt.status = result.status === "skipped" ? "skipped" : "imported";
        await this.writeState(state);
      } catch (error) {
        receipt.status = "unknown";
        result.status = "unknown";
        result.detail = "写入结果未知，禁止自动重试，请检查目标内容。";
        if (error instanceof SessionImportCleanupError) {
          const retained = error.retainedAttachmentPaths.slice(0, 8).map((file) => JSON.stringify(file.slice(0, 160)));
          result.detail += ` 未清理的附件：${retained.join("、")}${error.retainedAttachmentPaths.length > 8 ? "（更多路径未显示）" : ""}`;
        }
        result.detail = result.detail.slice(0, 1_700);
        await this.writeState(state);
      } finally {
        if (stagedPath) {
          try { await fs.rm(stagedPath, { force: true }); }
          catch { result.detail = `${result.detail ?? ""} 临时副本清理失败：${JSON.stringify(stagedPath.slice(0, 256))}`; }
        }
        result.detail = result.detail?.slice(0, 2_048);
      }
    }
    return history;
  }

  private async scan(source: ApplicationImportSource, filePath?: string): Promise<ScannedSource> {
    const preview: StoredPreview = { id: randomUUID(), source,
      label: source === "chatgpt" && filePath !== undefined ? `${applicationImportSources.chatgpt.label} · ${path.basename(filePath).slice(0, 256)}` : applicationImportSources[source].label,
      filePath: filePath === undefined ? undefined : path.resolve(filePath), items: [], warnings: [] };
    const configurations = new Map<string, ConfigurationImportCandidate>();
    const contents = new Map<string, Buffer>();
    let preparedChatGpt: PreparedChatGptSource | undefined;
    if (source !== "chatgpt") {
      try {
        for (const candidate of await discoverConfigurationImports(source, this.homeDir)) {
          if (preview.items.length >= maxItems) { preview.warnings.push("设置项目超过 256 项，只显示前 256 项。"); break; }
          const id = `configuration:${candidate.id}`;
          configurations.set(candidate.id, candidate);
          preview.items.push({ id, category: candidate.category, label: candidate.label, detail: candidate.detail, configurationId: candidate.id, sourceHash: candidate.fingerprint, digest: candidate.fingerprint });
        }
      } catch { preview.warnings.push("部分源设置不可读取或格式无效，未列为可导入项目。"); }
    }
    const files = source === "chatgpt"
      ? filePath === undefined ? [] : [path.resolve(filePath)]
      : await this.localSessionFiles(source, preview.warnings);
    let totalBytes = 0;
    for (const sourcePath of files) {
      if (preview.items.length >= maxItems) { preview.warnings.push("来源项目超过 256 项，请缩小来源范围后重试。"); break; }
      try {
        const bytes = await readRegularFile(sourcePath, maxSourceBytes);
        totalBytes += bytes.length;
        if (totalBytes > 256 * 1024 * 1024) { preview.warnings.push("来源总大小超过扫描上限，请缩小来源范围。"); break; }
        contents.set(sourcePath, bytes);
        const sourceHash = digest(bytes);
        if (source === "chatgpt") {
          preparedChatGpt = prepareChatGptSource(bytes.toString("utf8"), sourcePath);
          for (const { summary: conversation, stableId, contentHash: hashRecord } of preparedChatGpt.records(digest)) {
            if (preview.items.length >= maxItems) { preview.warnings.push("对话超过 256 项，只显示前 256 项。"); break; }
            const contentHash = hashRecord();
            if (!stableId) preview.warnings.push("部分对话缺少稳定来源身份；内容变化后需重新选择，不自动同步其他记录。");
            if (conversation.importError) preview.warnings.push(`对话不可导入：${conversation.title.slice(0, 256)}`);
            preview.items.push({ id: `session:${digest(`${sourcePath}\0${conversation.id}\0${stableId ? "" : contentHash}`)}`, category: "sessions", label: conversation.title.slice(0, 512), detail: `${conversation.messageCount} 条消息 · ${path.basename(sourcePath).slice(0, 256)}`, sourcePath, conversationId: conversation.id, sourceHash, digest: contentHash });
          }
        } else {
          preview.items.push({ id: `session:${digest(sourcePath)}`, category: "sessions", label: path.basename(sourcePath, ".jsonl").slice(0, 512), detail: sourcePath.slice(0, 2_048), sourcePath, sourceHash, digest: sourceHash });
        }
      } catch { preview.warnings.push(`跳过不可读取、不安全或格式无效的来源：${path.basename(sourcePath).slice(0, 256)}`); }
    }
    preview.warnings = preview.warnings.slice(0, 256);
    return { preview, configurations, contents, preparedChatGpt };
  }

  private async localSessionFiles(source: "claude" | "codex", warnings: string[]): Promise<string[]> {
    const sourceRoot = path.join(this.homeDir, source === "claude" ? ".claude" : ".codex");
    const root = path.join(sourceRoot, source === "claude" ? "projects" : "sessions");
    const files: string[] = [];
    let scanned = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > (source === "claude" ? 1 : 8) || scanned >= maxScanEntries || files.length >= maxItems) return;
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { warnings.push("跳过不安全的来源目录。"); return; }
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++scanned > maxScanEntries || files.length >= maxItems) break;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { warnings.push("跳过来源中的符号链接。"); continue; }
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && (source === "claude" || entry.name.startsWith("rollout-"))) files.push(file);
      }
    };
    try {
      const stat = await fs.lstat(sourceRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { warnings.push("跳过不安全的应用来源目录。"); return []; }
      await visit(root, 0);
      if (scanned >= maxScanEntries || files.length >= maxItems) warnings.push("来源扫描已达到数量上限。");
    } catch (error) { if (!isNotFound(error)) warnings.push("无法完整读取本机来源目录。"); }
    return files;
  }

  private async withState<T>(action: (state: ImportState) => Promise<T>): Promise<T> {
    await fs.mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.stateRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("导入状态目录必须是真实目录。");
    this.stateRoot = await fs.realpath(this.stateRoot);
    return await withLocalFileWriteLock(this.stateRoot, ".imports.lock", async () => {
      const state = await this.readState();
      for (const receipt of state.receipts) {
        if (receipt.status !== "attempting") continue;
        receipt.status = "unknown";
        const result = state.history.find((history) => history.id === receipt.historyId)?.results.find((entry) => entry.id === receipt.itemId);
        if (result) { result.status = "unknown"; result.detail = "上次导入中断，写入结果未知，禁止自动重试。"; }
      }
      const result = await action(state);
      await this.writeState(state);
      return structuredClone(result);
    });
  }

  private async readState(): Promise<ImportState> {
    try { return stateSchema.parse(JSON.parse((await readRegularFile(path.join(this.stateRoot, "state.json"), maxStateBytes)).toString("utf8"))); }
    catch (error) {
      if (!isNotFound(error)) throw new Error("导入状态无法安全读取，请保留文件并检查状态。");
      return { version: 1, previews: [], history: [], receipts: [], sync: { enabled: false, selections: [] } };
    }
  }

  private async writeState(state: ImportState): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(stateSchema.parse(state)), "utf8");
    if (bytes.length > maxStateBytes) throw new Error("导入状态超过存储上限。");
    const target = path.join(this.stateRoot, "state.json");
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("导入状态文件必须是真实单链接文件。");
    } catch (error) { if (!isNotFound(error)) throw error; }
    const temporary = path.join(this.stateRoot, `.state-${randomUUID()}.json`);
    const handle = await fs.open(temporary, "wx", 0o600);
    let identity: Stats | undefined;
    try {
      try { identity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
      const directory = await fs.open(this.stateRoot, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (identity) await removeOwnedTemporaryFile(temporary, identity);
    }
  }

  private async toSnapshot(state: ImportState): Promise<ApplicationImportSnapshot> {
    const detected = async (source: "claude" | "codex") => {
      try { const stat = await fs.lstat(path.join(this.homeDir, source === "claude" ? ".claude" : ".codex")); return stat.isDirectory() && !stat.isSymbolicLink(); }
      catch { return false; }
    };
    return {
      sources: await Promise.all(Object.values(applicationImportSources).map(async source => ({
        ...source, detected: source.source !== "chatgpt" && await detected(source.source)
      }))),
      history: state.history,
      sync: { enabled: state.sync.enabled, hasSelection: state.sync.selections.length > 0, lastError: state.sync.lastError,
        selections: state.sync.selections.map(({ source, filePath, workspaceRoot, itemIds }) => ({ source,
          label: source === "chatgpt" && filePath !== undefined ? `${applicationImportSources.chatgpt.label} · ${path.basename(filePath).slice(0, 256)}` : applicationImportSources[source].label,
          workspaceRoot, itemIds })) }
    };
  }
}

function publicPreview(preview: StoredPreview): ApplicationImportPreview {
  return { id: preview.id, source: preview.source, label: preview.label, items: preview.items.map(({ id, category, label, detail }) => ({ id, category, label, detail })), warnings: preview.warnings };
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
async function removeOwnedTemporaryFile(filePath: string, identity: Pick<Stats, "dev" | "ino">): Promise<void> {
  try {
    const current = await fs.lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1) throw new Error("导入状态临时文件身份变化，未删除无法确认归属的文件。");
    await fs.unlink(filePath);
  } catch (error) { if (!isNotFound(error)) throw error; }
}
async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw new Error("请选择已有的目标项目目录。");
  const canonical = await fs.realpath(workspaceRoot);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error("目标项目必须是目录。");
  return canonical;
}
async function canonicalFuturePath(targetPath: string): Promise<string> {
  let existing = path.resolve(targetPath);
  const suffix: string[] = [];
  while (true) {
    try { return path.join(await fs.realpath(existing), ...suffix); }
    catch (error) {
      if (!isNotFound(error) || path.dirname(existing) === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}
async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const parentPath = path.resolve(path.dirname(filePath));
  const parent = await fs.lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || await fs.realpath(parentPath) !== parentPath) throw new Error("来源父目录不能包含符号链接。");
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new Error("来源不是安全的有界文件。");
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > maxBytes) throw new Error("来源在读取时变化。");
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error("来源超过读取上限。");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const binding = await fs.lstat(filePath);
    const parentAfter = await fs.lstat(parentPath);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || binding.isSymbolicLink() || binding.ino !== after.ino || binding.dev !== after.dev
      || parentAfter.isSymbolicLink() || parentAfter.ino !== parent.ino || parentAfter.dev !== parent.dev || await fs.realpath(parentPath) !== parentPath) throw new Error("来源在读取时变化。");
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
