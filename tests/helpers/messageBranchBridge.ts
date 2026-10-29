/** Runs production preload and IPC handler functions with an in-process transport.
 * This is not an Electron process/security-boundary test; Manager/service are real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import type { DesktopAgentManager } from "../../src/desktop/electron/main/DesktopAgentManager.js";
import { idSchema } from "../../src/desktop/electron/main/settingsSaveInputSchema.js";
import { desktopIpc } from "../../src/desktop/protocol.js";

export function messageBranchBridge(manager: DesktopAgentManager): (projectId: string, sessionId: string, messageId: string) => Promise<string> {
  const preload = ts.createSourceFile("preload.ts", readFileSync("src/desktop/electron/preload/index.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const ipc = ts.createSourceFile("ipc.ts", readFileSync("src/desktop/electron/main/ipc.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const forwards: ts.Expression[] = [];
  const handlers: ts.Expression[] = [];
  const findForward = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(preload) === "branchSessionAtMessage") forwards.push(node.initializer);
    ts.forEachChild(node, findForward);
  };
  const findHandler = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ipc) === "handle"
      && node.arguments[0]?.getText(ipc) === "desktopIpc.branchSessionAtMessage") handlers.push(node.arguments[1]!);
    ts.forEachChild(node, findHandler);
  };
  findForward(preload); findHandler(ipc);
  assert.equal(forwards.length, 1); assert.equal(handlers.length, 1);
  const [forward] = forwards; const [handler] = handlers;
  const audit = (node: ts.Node, source: ts.SourceFile): void => {
    if (ts.isCallExpression(node)) assert.ok(new Set(["ipcRenderer.invoke", "context.agents.branchSessionAtMessage", "idSchema.parse"])
      .has(node.expression.getText(source)), `Unexpected transport call: ${node.expression.getText(source)}`);
    assert.equal(ts.isImportDeclaration(node) || ts.isNewExpression(node), false);
    ts.forEachChild(node, child => audit(child, source));
  };
  audit(forward!, preload); audit(handler!, ipc);
  const context = createContext({ desktopIpc, idSchema, context: { agents: manager },
    ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => {
      assert.equal(channel, desktopIpc.branchSessionAtMessage);
      return await invokeHandler(undefined, ...args);
    } }
  }, { codeGeneration: { strings: false, wasm: false } });
  const evaluate = (code: string): unknown => {
    const emitted = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
    assert.equal(emitted.diagnostics?.length ?? 0, 0);
    return new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  };
  const invokeHandler = evaluate(`(${handler!.getText(ipc)})`) as (...args: unknown[]) => Promise<string>;
  return evaluate(`(${forward!.getText(preload)})`) as (projectId: string, sessionId: string, messageId: string) => Promise<string>;
}
