/**
 * 工具展示规则模块。
 *
 * 这里只负责把工具调用参数转换成权限确认所需的标题、摘要和 diff。它不执行工具、不记录 session，
 * 也不决定是否允许调用，保证 UI 展示格式不会影响工具协议。
 */
import { analyzePermissionRequest, commandSafetyWarnings } from "../../permission/policy.js";
import type { PermissionPrompt, PermissionRequestContext } from "../../permission/PermissionManager.js";
import { createUnifiedDiff } from "../../utils/diff.js";
import { redactSecrets, redactSensitiveValue } from "../../utils/secrets.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { applyHashlineEdits } from "../file/hashline.js";
import { applyStringEdit } from "../file/stringEdit.js";
import { patchArgsSchema, patchContent } from "../file/applyPatch.js";
import { editArgsSchema } from "../file/editFile.js";
import { maxEditFileBytes, readBoundedUtf8File } from "../file/safeFileIo.js";
export interface ToolCallInput {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolDisplayContext {
  workspaceRoot: string;
  ignore: string[];
  sessionId?: string;
}

export interface ToolDisplayRule {
  title: string;
  summarize(args: unknown, context: ToolDisplayContext): Promise<ToolDisplaySummary>;
}

export interface ToolDisplaySummary {
  details: string;
  diff?: string;
  preview?: string;
  requireFullYes?: boolean;
  changeSummary?: string;
}

export async function createToolPermissionRequest(
  call: ToolCallInput,
  context: ToolDisplayContext,
  permissionContext?: PermissionRequestContext
): Promise<PermissionPrompt> {
  const requestContext = permissionContext ?? analyzePermissionRequest({
    toolName: call.name,
    args: call.args,
    sessionId: context.sessionId ?? "",
    projectRoot: context.workspaceRoot
  });
  const rule = toolDisplayRules[call.name] ?? defaultDisplayRule;
  const summary = await rule.summarize(call.args, context);
  const diff = summary.diff === undefined ? undefined : redactSecrets(summary.diff);
  const preview = summary.preview === undefined ? undefined : redactSecrets(summary.preview);
  return {
    ...requestContext,
    command: requestContext.command === undefined ? undefined : redactSecrets(requestContext.command),
    reason: requestContext.reason === undefined ? undefined : redactSecrets(requestContext.reason),
    toolCallId: call.id,
    tool: call.name,
    title: rule.title,
    details: redactSecrets(summary.details),
    requireFullYes: summary.requireFullYes ?? requestContext.riskLevel === "critical",
    diff,
    preview,
    diffPreview: diff,
    changeSummary: summary.changeSummary === undefined ? undefined : redactSecrets(summary.changeSummary)
  };
}

export const toolDisplayRules: Record<string, ToolDisplayRule> = {
  apply_patch: {
    title: "File patch request",
    async summarize(args, context) {
      const { operation } = patchArgsSchema.parse(args);
      const content = await readExistingFileForDiff(operation.path, context, operation.type === "create_file");
      const diff = createUnifiedDiff(operation.path, content, patchContent(content, operation));
      return { details: `${operation.type}: ${operation.path}`, diff, preview: formatUnifiedDiffPreview(operation.path, diff, 16), requireFullYes: operation.type === "delete_file" };
    }
  },
  Bash: {
    title: "Command execution request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Run command: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  Write: {
    title: "File write request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const content = getStringField(args, "content");
      const oldContent = await readExistingFileForDiff(filePath, context, true);
      const diff = oldContent ? createUnifiedDiff(filePath, oldContent, content) : undefined;
      const preview = oldContent
        ? formatUnifiedDiffPreview(filePath, diff ?? "", 16)
        : formatFileContentPreview(filePath, content, 16);
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(content, "utf8")}`,
        diff,
        preview,
        changeSummary: oldContent ? `Overwrite ${filePath}` : `Create ${filePath}`
      };
    }
  },
  Edit: {
    title: "File change request",
    async summarize(args, context) {
      const parsed = editArgsSchema.parse(args);
      const filePath = parsed.path;
      const oldContent = await readExistingFileForDiff(filePath, context);
      if (parsed.operation === "delete") {
        const diff = createUnifiedDiff(filePath, oldContent, "");
        return {
          details: `File: ${filePath}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
          diff,
          preview: formatUnifiedDiffPreview(filePath, diff, 16),
          changeSummary: `Delete ${filePath}`,
          requireFullYes: true
        };
      }
      if (parsed.operation === "move") {
        return {
          details: `Move ${filePath} -> ${parsed.to}\nBytes: ${Buffer.byteLength(oldContent, "utf8")}`,
          preview: formatFileContentPreview(filePath, oldContent, 12),
          changeSummary: `Move ${filePath} to ${parsed.to}`,
          requireFullYes: true
        };
      }
      const next = "edits" in parsed ? applyHashlineEdits(oldContent, parsed.edits) : applyStringEdit(oldContent, parsed.old_string, parsed.new_string, parsed.replace_all);
      const diff = createUnifiedDiff(filePath, oldContent, next.content);
      const preview = formatUnifiedDiffPreview(filePath, diff, 16);
      return {
        details: `File: ${filePath}`,
        diff,
        preview,
        changeSummary: `Edit ${filePath}`
      };
    }
  },
  skill_install: {
    title: "Skill installation request",
    async summarize(args) {
      const name = getStringField(args, "name");
      const owner = getStringField(args, "repoOwner");
      const repository = getStringField(args, "repoName");
      const directory = getStringField(args, "directory");
      return {
        details: `Skill: ${name}\nSource: ${owner}/${repository}:${directory}\nTarget: ~/.config/biny/skills/`,
        changeSummary: `Install Skill ${name}`
      };
    }
  },
  BrowserType: {
    title: "Browser form fill request",
    async summarize(args) {
      const selector = getStringField(args, "selector");
      return {
        details: `Selector: ${selector}\nValue: [redacted before display]`,
        changeSummary: `Fill browser field ${selector}`
      };
    }
  }
};

const defaultDisplayRule: ToolDisplayRule = {
  title: "Tool permission request",
  async summarize(args) {
    return { details: JSON.stringify(redactSensitiveValue(args), null, 2) };
  }
};

async function readExistingFileForDiff(filePath: string, context: ToolDisplayContext, allowMissing = false): Promise<string> {
  const absolutePath = resolveWorkspacePath(context.workspaceRoot, filePath, context.ignore);
  try {
    return (await readBoundedUtf8File(absolutePath, maxEditFileBytes, "reject")).content;
  } catch (error) {
    if (allowMissing && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

// Permission previews are plain text shared by CLI and TUI. They deliberately
// stay in the tool domain so a core tool never imports a TUI rendering module.
function formatFileContentPreview(filePath: string, content: string, maxLines: number): string {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = normalized ? normalized.split("\n") : [];
  const shown = lines.slice(0, maxLines);
  return [
    `内容：${filePath}`,
    ...shown.map((line, index) => `${String(index + 1).padStart(4, " ")}   ${line}`),
    ...(lines.length > shown.length ? [`     … ${String(lines.length - shown.length)} 行未展示`] : [])
  ].join("\n");
}

function formatUnifiedDiffPreview(filePath: string, diff: string, maxLines: number): string {
  const body: string[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diff.split("\n")) {
    const range = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (range) {
      oldLine = Number.parseInt(range[1] ?? "1", 10);
      newLine = Number.parseInt(range[2] ?? "1", 10);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) {
      body.push(`${String(oldLine).padStart(4, " ")} - ${line.slice(1)}`);
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      body.push(`${String(newLine).padStart(4, " ")} + ${line.slice(1)}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      body.push(`${String(newLine).padStart(4, " ")}   ${line.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    }
  }

  return [
    `变更：${filePath}`,
    ...body.slice(0, maxLines),
    ...(body.length > maxLines ? [`     … ${String(body.length - maxLines)} 行未展示`] : [])
  ].join("\n");
}
