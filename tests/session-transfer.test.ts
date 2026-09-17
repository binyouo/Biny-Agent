/**
 * 会话命名、目录迁移与导入导出的端到端测试。
 *
 * 隔离约定：用 BINY_AGENT_DIR 把全局 agent 目录重定向到临时目录，本测试绝不触碰真实
 * `~/.biny`。新写法参考：先 mkdtemp + realpath（macOS 上 /var 是 symlink），再设环境变量。
 */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-transfer-agent-"));
process.env.BINY_AGENT_DIR = agentRoot;

const { attachmentRoot, readAttachment, saveAttachment } = await import("../src/attachments/store.js");
const { globalAgentDir, legacyProjectStateDirName, projectSessionsDir, projectStateDirName } = await import("../src/config/paths.js");
const { readStoredSessionEvents } = await import("../src/session/events.js");
const { createSessionId, SessionRecorder } = await import("../src/session/recorder.js");
const { RuntimeEventAuthority } = await import("../src/runtime/RuntimeAuthority.js");
const { ensureAgentDirs, resolveSessionFile } = await import("../src/session/store.js");
const {
  BINY_BUNDLE_FORMAT,
  BINY_BUNDLE_VERSION,
  exportSessionBundle,
  exportSessionClaudeCode,
  importSessionFile
} = await import("../src/session/transfer.js");

const createdRoots: string[] = [agentRoot];

async function tempWorkspace(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), label)));
  createdRoots.push(root);
  return root;
}

async function recordConversation(root: string, withAttachment: boolean): Promise<{ sessionId: string; attachmentPath?: string }> {
  await ensureAgentDirs(root);
  let attachments;
  let attachmentPath: string | undefined;
  if (withAttachment) {
    const saved = await saveAttachment(root, "note.txt", "text/plain", Buffer.from("hello attachment"));
    attachments = [saved];
    attachmentPath = saved.path;
  }
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "帮我看下这个文件", attachments });
  recorder.record({ type: "tool_call", tool: "Read", args: { path: "note.txt" }, toolCallId: "call_1" });
  recorder.record({ type: "tool_result", tool: "Read", toolCallId: "call_1", result: "hello attachment", executionStatus: "succeeded" });
  recorder.record({ type: "assistant_message", content: "文件内容是 hello attachment", reasoningContent: "先读文件再总结" });
  await recorder.close();
  return { sessionId: recorder.sessionId, attachmentPath };
}

try {
  // ── 命名：sessionId 自带可读时间戳，目录名 basename-hash8 ──────────────────
  {
    assert.match(createSessionId(), /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/u);
    assert.match(projectStateDirName("/tmp/some/biny"), /^biny-[0-9a-f]{8}$/u);
    assert.match(projectStateDirName("/tmp/some/My Proj!"), /^My-Proj-[0-9a-f]{8}$/u);
    assert.match(projectStateDirName("/tmp/some/我的项目"), /^我的项目-[0-9a-f]{8}$/u);
    assert.match(projectStateDirName("/tmp/some/.hidden"), /^hidden-[0-9a-f]{8}$/u);
    const longName = `x${"很长的项目名".repeat(30)}`;
    assert.ok(projectStateDirName(longName).length <= 48 + 9);
    // 同名不同路径靠 hash8 消歧。
    assert.notEqual(projectStateDirName("/tmp/a/biny"), projectStateDirName("/tmp/b/biny"));
  }

  // ── 迁移：旧 24hex 目录 + 日期分层 + .DS_Store → rename 到新目录并摊平 ──────
  {
    const root = await tempWorkspace("biny-migrate-ws-");
    const legacyDir = path.join(globalAgentDir(), "sessions", legacyProjectStateDirName(root));
    const dated = path.join(legacyDir, "2026", "08", "26");
    await mkdir(dated, { recursive: true });
    await mkdir(path.join(legacyDir, ".catalog"), { recursive: true });
    await writeFile(path.join(dated, "20260826-100000-abcdef12.jsonl"), `${JSON.stringify({ type: "user_message", content: "旧会话", time: "2026-08-26T02:00:00.000Z" })}\n`);
    await writeFile(path.join(legacyDir, ".DS_Store"), "finder junk");
    await writeFile(path.join(legacyDir, ".catalog", "20260826-100000-abcdef12.json"), JSON.stringify({ version: 1, sessionId: "20260826-100000-abcdef12", title: "旧标题" }));

    await ensureAgentDirs(root);

    const newDir = projectSessionsDir(root);
    assert.match(path.basename(newDir), /^biny-migrate-ws-[0-9A-Za-z]+-[0-9a-f]{8}$/u);
    // 旧目录消失、文件摊平到根、.DS_Store 放行没炸、catalog 记录跟着走。
    await assert.rejects(lstat(legacyDir), /ENOENT/u);
    const migrated = path.join(newDir, "20260826-100000-abcdef12.jsonl");
    assert.ok((await lstat(migrated)).isFile());
    assert.ok((await lstat(path.join(newDir, ".catalog", "20260826-100000-abcdef12.json"))).isFile());
    assert.equal(await resolveSessionFile(root, "20260826-100000-abcdef12"), migrated);
    assert.equal((await lstat(migrated)).mode & 0o777, 0o600);
  }

  // ── 迁移：新旧目录同时存在 → 并入而不是跳过 ────────────────────────────────
  {
    const root = await tempWorkspace("biny-merge-ws-");
    const legacyDir = path.join(globalAgentDir(), "sessions", legacyProjectStateDirName(root));
    const newDir = projectSessionsDir(root);
    await mkdir(path.join(legacyDir, "2026", "08", "26"), { recursive: true });
    await mkdir(path.join(legacyDir, ".catalog"), { recursive: true });
    await mkdir(path.join(newDir, ".catalog"), { recursive: true });
    const legacyEvent = `${JSON.stringify({ type: "user_message", content: "旧版写入", time: "2026-08-26T03:00:00.000Z" })}\n`;
    const freshEvent = `${JSON.stringify({ type: "user_message", content: "新版写入", time: "2026-08-26T04:00:00.000Z" })}\n`;
    await writeFile(path.join(legacyDir, "2026", "08", "26", "20260826-110000-aaaa1111.jsonl"), legacyEvent);
    await writeFile(path.join(legacyDir, ".catalog", "20260826-110000-aaaa1111.json"), JSON.stringify({ version: 1, sessionId: "20260826-110000-aaaa1111", title: "旧版标题" }));
    await writeFile(path.join(newDir, "20260826-120000-bbbb2222.jsonl"), freshEvent);
    await writeFile(path.join(newDir, ".catalog", "20260826-120000-bbbb2222.json"), JSON.stringify({ version: 1, sessionId: "20260826-120000-bbbb2222", title: "新版标题" }));

    await ensureAgentDirs(root);

    await assert.rejects(lstat(legacyDir), /ENOENT/u);
    // 两个会话都在新目录根（旧的分层文件被摊平），两边的 catalog 记录都保住。
    assert.ok((await lstat(path.join(newDir, "20260826-110000-aaaa1111.jsonl"))).isFile());
    assert.ok((await lstat(path.join(newDir, "20260826-120000-bbbb2222.jsonl"))).isFile());
    assert.ok((await lstat(path.join(newDir, ".catalog", "20260826-110000-aaaa1111.json"))).isFile());
    assert.ok((await lstat(path.join(newDir, ".catalog", "20260826-120000-bbbb2222.json"))).isFile());
    const { events } = await readStoredSessionEvents(root, "20260826-110000-aaaa1111");
    assert.equal(events[0]?.type, "user_message");
  }

  // ── bundle：导出 → 导入另一工作区，事件与附件完整往返 ───────────────────────
  {
    const source = await tempWorkspace("biny-export-ws-");
    const target = await tempWorkspace("biny-import-ws-");
    await ensureAgentDirs(target);
    const { sessionId, attachmentPath } = await recordConversation(source, true);
    assert.ok(attachmentPath);

    const exported = await exportSessionBundle(source, sessionId);
    assert.equal(exported.extension, "json");
    const bundle = JSON.parse(exported.content) as {
      format: string; version: number; manifest: { sessionId: string; eventCount: number; attachmentCount: number };
      events: unknown[]; attachments: Array<{ name: string; sourcePath: string; size: number; data: string; sha256: string }>;
    };
    assert.equal(bundle.format, BINY_BUNDLE_FORMAT);
    assert.equal(bundle.version, BINY_BUNDLE_VERSION);
    assert.equal(bundle.manifest.sessionId, sessionId);
    assert.equal(bundle.events.length, 4);
    assert.equal(bundle.attachments.length, 1);
    assert.equal(bundle.attachments[0]?.name, "note.txt");
    assert.equal(Buffer.from(bundle.attachments[0]?.data ?? "", "base64").toString(), "hello attachment");
    assert.match(bundle.attachments[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);

    const bundlePath = path.join(target, "import.biny.json");
    await writeFile(bundlePath, exported.content);
    const imported = await importSessionFile(target, bundlePath);
    assert.equal(imported.format, "biny");
    assert.notEqual(imported.sessionId, sessionId); // 永不复用来源 id
    assert.match(imported.sessionId, /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/u);
    assert.equal(imported.eventCount, 4);
    assert.equal(imported.attachmentsRestored, 1);
    assert.equal(imported.attachmentsRenamed, 1); // saveAttachment 自带新前缀，必然换路径

    const { events } = await readStoredSessionEvents(target, imported.sessionId);
    const sourceEvents = (await readStoredSessionEvents(source, sessionId)).events;
    assert.deepEqual(events.map((event) => event.type), ["user_message", "tool_call", "tool_result", "assistant_message"]);
    assert.notEqual(events[0]?.runtime?.eventId, sourceEvents[0]?.runtime?.eventId);
    const user = events[0];
    assert.equal(user?.type, "user_message");
    const refs = (user as { attachments?: Array<{ path: string; name: string }> }).attachments;
    assert.ok(refs?.[0]);
    assert.notEqual(refs[0].path, attachmentPath); // 引用已回填到新路径
    const restored = await readAttachment(target, refs[0] as never);
    assert.ok(restored);
    // 落到磁盘的附件字节也读得回来。
    const disk = await readFile(path.join(attachmentRoot(target), path.basename(refs[0].path)));
    assert.equal(disk.toString(), "hello attachment");

    const importedAgain = await importSessionFile(target, bundlePath);
    const importedAgainEvents = (await readStoredSessionEvents(target, importedAgain.sessionId)).events;
    assert.notEqual(importedAgainEvents[0]?.runtime?.eventId, events[0]?.runtime?.eventId);
    const reopenedAuthority = await RuntimeEventAuthority.open(target);
    reopenedAuthority.close();

    const damagedBundles = [
      { label: "base64", mutate: (attachment: typeof bundle.attachments[number]) => { attachment.data = "!!!!"; } },
      { label: "size", mutate: (attachment: typeof bundle.attachments[number]) => { attachment.size += 1; } },
      { label: "checksum", mutate: (attachment: typeof bundle.attachments[number]) => { attachment.sha256 = "0".repeat(64); } }
    ];
    for (const damaged of damagedBundles) {
      const corrupted = structuredClone(bundle);
      damaged.mutate(corrupted.attachments[0]!);
      const corruptedPath = path.join(target, `import-damaged-${damaged.label}.biny.json`);
      await writeFile(corruptedPath, `${JSON.stringify(corrupted)}\n`);
      const corruptedImport = await importSessionFile(target, corruptedPath);
      assert.equal(corruptedImport.attachmentsRestored, 0);
      assert.equal(corruptedImport.attachmentsSkipped, 1);
      assert.deepEqual(corruptedImport.skippedAttachmentIssues, [{ name: "note.txt", reason: "invalid" }]);
    }
  }

  // ── Claude Code：导出 .jsonl 再导入，对话事实保持 ──────────────────────────
  {
    const source = await tempWorkspace("biny-claude-out-");
    const target = await tempWorkspace("biny-claude-in-");
    await ensureAgentDirs(target);
    const { sessionId } = await recordConversation(source, false);

    const exported = await exportSessionClaudeCode(source, sessionId);
    assert.equal(exported.extension, "jsonl");
    const lines = exported.content.trim().split("\n").map((line) => JSON.parse(line) as {
      type: string; message: { role: string; content: unknown };
    });
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.map((line) => [line.type, line.message.role]), [
      ["user", "user"],
      ["assistant", "assistant"],
      ["user", "user"], // tool_result 在 Claude 里由 user 角色承载
      ["assistant", "assistant"]
    ]);

    const claudePath = path.join(target, "import.claude.jsonl");
    await writeFile(claudePath, exported.content);
    const imported = await importSessionFile(target, claudePath);
    assert.equal(imported.format, "claude");
    const { events } = await readStoredSessionEvents(target, imported.sessionId);
    assert.deepEqual(events.map((event) => event.type), ["user_message", "tool_call", "tool_result", "assistant_message"]);
    const toolCall = events[1];
    const toolResult = events[2];
    assert.equal(toolCall?.type, "tool_call");
    assert.equal((toolCall as { tool: string }).tool, "Read");
    assert.equal((toolCall as { toolCallId?: string }).toolCallId, "call_1");
    assert.equal(toolResult?.type, "tool_result");
    assert.equal((toolResult as { toolCallId?: string }).toolCallId, "call_1");
    assert.equal((toolResult as { executionStatus?: string }).executionStatus, "succeeded");
  }

  // ── Codex：rollout JSONL 导入映射 ─────────────────────────────────────────
  {
    const target = await tempWorkspace("biny-codex-in-");
    await ensureAgentDirs(target);
    const rollout = [
      // 真实 rollout 首行是 session_meta，探测不能只看首行。
      { timestamp: "2026-08-26T09:59:59.000Z", type: "session_meta", payload: { session_id: "019efa4b-b5b5" } },
      { type: "response_item", timestamp: "2026-08-26T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex 你好" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "先想一下" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_9", arguments: "{\"cmd\":\"pwd\"}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call_9", output: "{\"output\":\"/tmp\"}" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] } }
    ];
    const codexPath = path.join(target, "rollout-2026-08-26.jsonl");
    await writeFile(codexPath, `${rollout.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const imported = await importSessionFile(target, codexPath);
    assert.equal(imported.format, "codex");
    const { events } = await readStoredSessionEvents(target, imported.sessionId);
    assert.deepEqual(events.map((event) => event.type), ["user_message", "tool_call", "tool_result", "assistant_message"]);
    assert.equal(events[0]?.type === "user_message" ? events[0].content : undefined, "codex 你好");
    const call = events[1];
    assert.equal(call?.type, "tool_call");
    assert.deepEqual((call as { args: unknown }).args, { cmd: "pwd" });
    assert.equal((call as { reasoningContent?: string }).reasoningContent, "先想一下");
    const result = events[2];
    assert.equal(result?.type, "tool_result");
    assert.equal((result as { result: unknown }).result, "/tmp");
    assert.equal(events[3]?.type === "assistant_message" ? events[3].content : undefined, "完成");
  }

  // ── 格式探测：bundle / claude / codex / 无法识别 ───────────────────────────
  {
    const target = await tempWorkspace("biny-detect-in-");
    await ensureAgentDirs(target);
    const { sessionId } = await recordConversation(target, false);
    const bundle = await exportSessionBundle(target, sessionId);
    const claude = await exportSessionClaudeCode(target, sessionId);

    const bundlePath = path.join(target, "x.json");
    await writeFile(bundlePath, bundle.content);
    assert.equal((await importSessionFile(target, bundlePath)).format, "biny");

    const claudePath = path.join(target, "y.jsonl");
    await writeFile(claudePath, claude.content);
    assert.equal((await importSessionFile(target, claudePath)).format, "claude");

    const garbagePath = path.join(target, "z.jsonl");
    await writeFile(garbagePath, "{\"foo\":1}\n");
    await assert.rejects(importSessionFile(target, garbagePath), /无法识别会话文件格式/u);
  }

  console.log("session-transfer tests passed");
} finally {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
