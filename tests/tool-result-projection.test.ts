import assert from "node:assert/strict";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import type { AgentMessage, AgentToolResultMessage } from "../src/agent/core/types.js";

await testFileAndCommandProjection();
await testRemovedFileToolUsesGenericProjection();
await testSemanticReplacementAndParallelIsolation();
await testUnknownFailureIsNotMerged();
await testArchiveFailureKeepsOriginal();
await testRunCommandTruncationMetadata();
await testBashOutputProjectionKeepsPagination();
await testBashProjectionBoundsBothStreams();
await testRecentBashProjectionKeepsStreams();

console.log("tool result projection tests passed");

async function testBashProjectionBoundsBothStreams(): Promise<void> {
  // No command echo: removing it must not be mistaken for bounding the streams.
  // The stdout boundary also falls inside a surrogate pair.
  const stdout = "old stdout\n".repeat(1_000) + "😀" + "x".repeat(5_999);
  const stderr = "old stderr\n".repeat(1_000) + "错误".repeat(4_000);
  for (const captureMetadata of [false, true]) {
    const original = {
      status: "completed",
      exitCode: 0,
      stdout,
      stderr,
      ...(captureMetadata ? {
        stdoutBytes: Buffer.byteLength(stdout, "utf8") + 1_000,
        stdoutRetainedBytes: Buffer.byteLength(stdout, "utf8"),
        stdoutTruncated: true,
        stderrBytes: Buffer.byteLength(stderr, "utf8") + 2_000,
        stderrRetainedBytes: Buffer.byteLength(stderr, "utf8"),
        stderrTruncated: true
      } : {})
    };
    for (const mode of ["single", "history"] as const) {
      const archived: string[] = [];
      const options = {
        keepRecentResults: 0,
        archiveResult: async ({ output }: { output: string }) => {
          archived.push(output);
          return { archivePath: `.biny/tool-results/tool-result-${"b".repeat(64)}.json`, resultBytes: Buffer.byteLength(output, "utf8") };
        }
      };
      const projected = mode === "single"
        ? await projectSingleToolResultForModel("Bash", { command: "pnpm test" }, original, options) as Record<string, unknown>
        : resultDetails((await projectToolResultsForModel([
          { role: "user", content: "inspect command output" },
          assistantCall("bounded-command", "Bash", { command: "pnpm test" }),
          toolResult("bounded-command", "Bash", original)
        ], options))[2]);

      assert.ok(String(projected.stdout).length <= 6_000, `${mode} stdout must be bounded to 6,000 characters`);
      assert.ok(String(projected.stderr).length <= 6_000, `${mode} stderr must be bounded to 6,000 characters`);
      assert.equal(projected.stdout, "x".repeat(5_999), `${mode} stdout must contain only the safe tail`);
      assert.equal(projected.stderr, "错误".repeat(3_000), `${mode} stderr must contain only the tail`);
      for (const stream of ["stdout", "stderr"] as const) {
        assert.equal(projected[`${stream}Truncated`], true);
        assert.equal(projected[`${stream}TruncationDirection`], "tail");
        assert.equal(projected[`${stream}RetainedBytes`], Buffer.byteLength(String(projected[stream]), "utf8"));
        assert.equal(projected[`${stream}Bytes`], original[`${stream}Bytes`] ?? Buffer.byteLength(original[stream], "utf8"));
      }
      assert.equal(projected.archived, true);
      assert.deepEqual(archived.map((output) => JSON.parse(output)), [original]);
      assert.equal(original.stdout, stdout);
      assert.equal(original.stderr, stderr);
    }
  }
}

async function testRecentBashProjectionKeepsStreams(): Promise<void> {
  const original = {
    status: "completed",
    exitCode: 0,
    stdout: "recent stdout\n".repeat(1_000),
    stderr: "recent stderr\n".repeat(1_000)
  };
  const messages: AgentMessage[] = [
    { role: "user", content: "inspect command output" },
    assistantCall("recent-command", "Bash", { command: "pnpm test" }),
    toolResult("recent-command", "Bash", original)
  ];
  const projected = resultDetails((await projectToolResultsForModel(messages))[2]);
  assert.equal(projected.stdout, original.stdout);
  assert.equal(projected.stderr, original.stderr);
  assert.equal(projected.stdoutTruncated, false);
  assert.equal(projected.stderrTruncated, false);
}

async function testFileAndCommandProjection(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "make the change" },
    assistantCall("write-1", "Write", { path: "src/example.ts", content: "new\ncontent\n" }),
    toolResult("write-1", "Write", {
      change: { operation: "update", path: "src/example.ts", bytes: 12, committed: true, diff: "@@ -1 +1,2 @@\n-old\n+new\n+content" },
      changeSummary: "Overwrite src/example.ts"
    }),
    assistantCall("command-1", "Bash", { command: "pnpm test" }),
    toolResult("command-1", "Bash", {
      status: "completed",
      exitCode: 0,
      stdout: "pnpm test\n" + "old output\n".repeat(1_000),
      stderr: "",
      stdoutBytes: 11_000,
      stdoutRetainedBytes: 11_000,
      stdoutTruncated: false,
      stderrBytes: 0,
      stderrRetainedBytes: 0,
      stderrTruncated: false
    }),
    assistantCall("recent", "unknown_tool", { value: 1 }),
    toolResult("recent", "unknown_tool", { ok: true }),
    assistantCall("recent-2", "unknown_tool", { value: 2 }),
    toolResult("recent-2", "unknown_tool", { ok: true })
  ];
  const archiveRequests: Array<{ sequence: number; output: string }> = [];
  const projected = await projectToolResultsForModel(messages, {
    thresholdBytes: 512,
    archiveResult: async (request) => {
      archiveRequests.push({ sequence: request.sequence, output: request.output });
      const suffix = request.sequence.toString(16).padStart(64, "0");
      return { archivePath: `.biny/tool-results/tool-result-${suffix}.json`, resultBytes: request.output.length };
    }
  });

  const write = resultDetails(projected[2]);
  assert.equal(write.path, "src/example.ts");
  assert.equal(write.changeSummary, "Overwrite src/example.ts");
  assert.equal(write.addedLines, 2);
  assert.equal(write.deletedLines, 1);
  assert.equal("diffPreview" in write, false);
  assert.equal("contentPreview" in write, false);

  const command = resultDetails(projected[4]);
  assert.equal(String(command.stdout).includes("pnpm test"), false, "the command already exists in the tool call");
  assert.equal(String(command.stdout).length < String(resultDetails(messages[4]).stdout).length, true);
  assert.equal(command.stdoutTruncated, true);
  assert.match(String(command.summary), /tail/i);
  assert.equal(archiveRequests.length, 1, "only the large command result needs an archive");
  assert.equal(messages[2]?.role, "toolResult");
  assert.equal((messages[2] as AgentToolResultMessage).details, (resultDetails(messages[2])));
  assert.equal(String((messages[4] as AgentToolResultMessage).details?.stdout).startsWith("pnpm test"), true);
}

async function testRemovedFileToolUsesGenericProjection(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "migrate legacy history" },
    assistantCall("legacy-write", "write_file", { path: "src/legacy.ts", content: "new" }),
    toolResult("legacy-write", "write_file", {
      path: "src/legacy.ts",
      diffPreview: "@@ -1 +1 @@\n-old\n+new"
    })
  ];
  const projected = await projectToolResultsForModel(messages, { thresholdBytes: 512 });
  const result = resultDetails(projected[2]);
  assert.equal(result.path, "src/legacy.ts");
  assert.equal(result.addedLines, undefined);
  assert.equal(result.deletedLines, undefined);
  assert.equal(result.modelProjection, undefined);
}

async function testSemanticReplacementAndParallelIsolation(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "inspect the workspace" },
    assistantCall("read-old", "Read", { path: "src/index.ts" }),
    toolResult("read-old", "Read", { path: "src/index.ts", content: "old contents" }),
    assistantCall("read-new", "Read", { path: "src/index.ts" }),
    toolResult("read-new", "Read", { path: "src/index.ts", content: "new contents" }),
    assistantCall("status-old", "Bash", { command: "git status --short" }),
    toolResult("status-old", "Bash", { status: "completed", exitCode: 0, stdout: " M old.ts" }),
    assistantCall("status-new", "Bash", { command: "git status --short" }),
    toolResult("status-new", "Bash", { status: "completed", exitCode: 0, stdout: " M new.ts" }),
    assistantCall("unknown-old", "opaque_tool", { value: 7 }),
    toolResult("unknown-old", "opaque_tool", { result: "same" }),
    assistantCall("unknown-new", "opaque_tool", { value: 7 }),
    toolResult("unknown-new", "opaque_tool", { result: "same" }),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "parallel-a", name: "opaque_tool", arguments: { value: 9 } },
        { type: "toolCall", id: "parallel-b", name: "opaque_tool", arguments: { value: 9 } }
      ]
    },
    toolResult("parallel-a", "opaque_tool", { result: "parallel" }),
    toolResult("parallel-b", "opaque_tool", { result: "parallel" }),
    assistantCall("failure", "Bash", { command: "pnpm check" }),
    toolResult("failure", "Bash", { status: "failed", exitCode: 1, error: "failed" }),
    assistantCall("success", "Bash", { command: "pnpm check" }),
    toolResult("success", "Bash", { status: "completed", exitCode: 0, stdout: "passed" })
  ];
  const projected = await projectToolResultsForModel(messages, {
    archiveResult: async ({ sequence }) => ({
      archivePath: `.biny/tool-results/tool-result-${sequence.toString(16).padStart(64, "0")}.json`,
      resultBytes: sequence
    })
  });

  assert.match(resultText(projected[2]), /read covers/i);
  assert.match(resultText(projected[6]), /Git snapshot/i);
  assert.match(resultText(projected[10]), /identical tool call and result/i);
  assert.equal(resultText(projected[14]).includes("model projection"), false);
  assert.equal(resultText(projected[15]).includes("model projection"), false);
  assert.match(resultText(projected[17]), /resolved this earlier failure/i);
  assert.equal(resultText(projected[19]).includes("model projection"), false, "the successful replacement is retained");
}

async function testRunCommandTruncationMetadata(): Promise<void> {
  const script = "process.stdout.write('字'.repeat(400000)); process.stderr.write('界'.repeat(400000))";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const capped = await runShellCommand(process.cwd(), command);
  assert.equal(capped.status, "completed");
  assert.equal(capped.stdoutBytes, 1_200_000);
  assert.equal(capped.stderrBytes, 1_200_000);
  assert.equal(capped.stdoutTruncated, true);
  assert.equal(capped.stderrTruncated, true);
  assert.equal(capped.stdoutTruncationDirection, "tail");
  assert.equal(capped.stderrTruncationDirection, "tail");
  assert.equal(capped.stdout.includes("�"), false);
  assert.equal(capped.stderr.includes("�"), false);
  assert.equal(capped.stdoutRetainedBytes <= 1024 * 1024, true);
  assert.equal(capped.stderrRetainedBytes <= 1024 * 1024, true);

  const captured = await runShellCommand(process.cwd(), command, { captureFullOutput: true });
  assert.equal(captured.stdoutTruncated, false);
  assert.equal(captured.stderrTruncated, false);
  assert.equal(captured.stdoutBytes, captured.stdoutRetainedBytes);
  assert.equal(captured.stderrBytes, captured.stderrRetainedBytes);
  assert.equal(captured.stdout.length, 400_000);
  assert.equal(captured.stderr.length, 400_000);
}

async function testBashOutputProjectionKeepsPagination(): Promise<void> {
  const original = {
    process: { processId: "process-1", state: "running" },
    output: {
      processId: "process-1",
      logPath: "/tmp/process.log",
      content: "output\n".repeat(4_000),
      startOffset: 0,
      nextOffset: 28_000,
      totalBytes: 40_000,
      omittedBefore: false,
      hasMore: true
    }
  };
  const projected = await projectSingleToolResultForModel("BashOutput", { processId: "process-1" }, original, {
    toolCallId: "bash-output",
    archiveResult: async ({ output }) => ({
      archivePath: `.biny/tool-results/tool-result-${"a".repeat(64)}.json`,
      resultBytes: Buffer.byteLength(output, "utf8")
    })
  }) as Record<string, unknown>;
  const output = projected.output as Record<string, unknown>;
  assert.equal(output.hasMore, true);
  assert.equal(output.nextOffset, 28_000);
  assert.equal(output.contentTruncated, true);
  assert.equal(String(output.content).length < original.output.content.length, true);
}

async function testArchiveFailureKeepsOriginal(): Promise<void> {
  const original = {
    path: "failure.ts",
    diffPreview: "x".repeat(20_000)
  };
  const projected = await projectSingleToolResultForModel("write", { path: original.path }, original, {
    toolCallId: "archive-failure",
    archiveResult: async () => { throw new Error("archive unavailable"); }
  }) as Record<string, unknown>;
  assert.deepEqual(projected.result, original);
  assert.equal(projected.archivePath, undefined);
  assert.equal(projected.archiveError, "archive unavailable");
  assert.match(String(projected.summary), /complete result remains in session history/i);
}

async function testUnknownFailureIsNotMerged(): Promise<void> {
  const messages: AgentMessage[] = [
    { role: "user", content: "run opaque tool" },
    assistantCall("opaque-failure", "opaque_tool", { value: 3 }),
    toolResult("opaque-failure", "opaque_tool", { error: "temporary failure" }),
    assistantCall("opaque-success", "opaque_tool", { value: 3 }),
    toolResult("opaque-success", "opaque_tool", { ok: true })
  ];
  const projected = await projectToolResultsForModel(messages);
  assert.equal(resultText(projected[2]).includes("model projection"), false);
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResult(id: string, toolName: string, details: unknown): AgentToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: JSON.stringify(details) }],
    details
  };
}

function resultDetails(message: AgentMessage | undefined): Record<string, unknown> {
  if (!message || message.role !== "toolResult" || typeof message.details !== "object" || message.details === null) {
    throw new Error("Expected structured tool result.");
  }
  return message.details as Record<string, unknown>;
}

function resultText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "toolResult") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
