/** PTY 外部边界替身验证开发服务器启动去重与显式停止后的重启。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { test } from "node:test";
import { DesktopTerminalManager } from "../src/desktop/electron/main/DesktopTerminalManager.js";
test("重复启动开发服务器复用同一终端，不重复写入命令；停止后可重新启动", async () => {
  const writes: string[] = []; let created = 0; let killed = 0; let onSpawn: (() => void) | undefined;
  let dataHandler: ((data: string) => void) | undefined; let exitHandler: ((event: { exitCode: number }) => void) | undefined;
  const fake = { spawn: () => { created++; onSpawn?.(); return { resize() {}, onData(handler: (data: string) => void) { dataHandler = handler; }, onExit(handler: (event: { exitCode: number }) => void) { exitHandler = handler; }, write(value: string) { writes.push(value); }, kill() { killed++; } }; } };
  Object.assign(globalThis, { __previewPty: fake });
  const hook = registerHooks({ load(url, context, next) { return /\/node-pty\/lib\/index\.js$/.test(url) ? { format: "module", source: "export const {spawn}=globalThis.__previewPty;", shortCircuit: true } : next(url, context); } });
  const manager = new DesktopTerminalManager(() => {});
  const server = createServer((_request, response) => response.writeHead(200).end("ok"));
  try {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const [a, b] = await Promise.all([manager.startPreview("p", "/tmp", "npm run dev"), manager.startPreview("p", "/tmp", "npm run dev")]);
    assert.equal(a.terminalId, b.terminalId); assert.equal(created, 1);
    assert.deepEqual(writes, ["npm run dev; exit\r"]);
    assert.deepEqual(manager.previewStatus("p"), { kind: "starting", terminalId: a.terminalId });
    dataHandler?.(`Local: http://localhost:${address.port}/\r\n`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("preview never became ready")), 2_000);
      const check = (): void => { if (manager.previewStatus("p").kind === "running") { clearTimeout(timeout); resolve(); } else setTimeout(check, 20); };
      check();
    });
    assert.deepEqual(manager.previewStatus("p"), { kind: "running", terminalId: a.terminalId, url: `http://localhost:${address.port}/` });
    await manager.startPreview("p", "/tmp", "npm run dev"); assert.equal(writes.length, 1);
    manager.dispose(a.terminalId);
    await manager.startPreview("p", "/tmp", "npm run dev"); assert.equal(created, 2);
    dataHandler?.("missing dependency\r\n"); exitHandler?.({ exitCode: 1 });
    assert.match(manager.previewFailure("p") ?? "", /missing dependency/);
    assert.match(manager.previewStatus("p").kind, /failed/);
    await manager.startPreview("p", "/tmp", "npm run dev");
    exitHandler?.({ exitCode: 0 });
    assert.equal(manager.previewStatus("p").kind, "failed");
    onSpawn = () => manager.disposeAll();
    await assert.rejects(manager.startPreview("q", "/tmp", "npm run dev"), /取消|关闭/);
    assert.equal(manager.list("q").length, 0);
    assert.ok(killed >= 2);
  } finally { manager.disposeAll(); server.closeAllConnections(); server.close(); hook.deregister(); Reflect.deleteProperty(globalThis, "__previewPty"); }
});
