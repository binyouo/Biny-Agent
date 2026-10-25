/**
 * 终端确认模块。
 *
 * 非 TUI 命令在执行有副作用工具前会调用这里，向用户展示标题、详情和可选的强确认要求。
 * TUI 模式会注入自己的权限 UI，因此这个模块只覆盖普通命令行交互。
 */
import { permissionPresentation } from "./presentation.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { permissionResultFromAnswer } from "./confirmation.js";
import type { PermissionPrompt, PermissionResult } from "./PermissionManager.js";

export async function confirmPermissionRequest(
  request: PermissionPrompt,
  signal?: AbortSignal
): Promise<PermissionResult> {
  const view = permissionPresentation(request);
  output.write(`\n${view.title} · ${request.tool}\n`);
  if (request.targetPath && !request.secondaryTargetPath) output.write(`${request.targetPath}\n`);
  if (request.command) output.write(`${request.command}\n`);
  if (view.details) output.write(`${view.details}\n`);
  if (view.reason) output.write(`${view.reason}\n`);
  if (request.preview) output.write(`${request.preview}\n`);
  if (request.canRemember === false) output.write("此操作按设置需要逐次确认。\n");
  const choices = request.requireFullYes
    ? ["  yes          允许一次", "  yes command  本会话允许"]
    : ["  y / Enter    允许一次", "  a            本会话允许"];
  if (request.canRemember === false) choices.pop();
  output.write([...choices, "  n            拒绝", "  r <理由>     拒绝并说明理由"].join("\n") + "\n");

  const rl = createInterface({ input, output });
  try {
    let result = permissionResultFromAnswer(await rl.question("> ", { signal }), request.requireFullYes);
    if (request.canRemember === false && result.action === "allow_always") result = { ...result, action: "allow_once", scope: "once" };
    if (result.action !== "deny_with_reason" || result.message?.trim()) return result;
    const reason = (await rl.question("拒绝理由（必填）：", { signal })).trim();
    return reason
      ? { ...result, message: reason }
      : { approved: false, action: "deny", scope: "once", message: "Denied by user.", confirmation: undefined };
  } finally {
    rl.close();
  }
}
