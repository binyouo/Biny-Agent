import assert from "node:assert/strict";
import { request } from "node:http";
import { Server, type AddressInfo } from "node:net";
import { test } from "node:test";
import { DesktopModelLoginService } from "../src/desktop/electron/main/DesktopModelLoginService.js";

test("malformed callback URLs and Unicode state cannot crash the server or prevent a later valid callback", { timeout: 10_000 }, async (context) => {
  const listen = Server.prototype.listen;
  const servers: Server[] = [];
  // 保留真实 HTTP 链路；测试的监听端口由系统分配，避免占用实际登录回调端口。
  context.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    servers.push(this);
    return Reflect.apply(listen, this, [0, ...args.slice(1)]);
  });
  let authorizationUrl: URL | undefined;
  const service = new DesktopModelLoginService(async (url) => { authorizationUrl = new URL(url); });
  const started = await service.start("openai-codex");
  try {
    const state = authorizationUrl!.searchParams.get("state")!;
    const port = (servers[0]!.address() as AddressInfo).port;
    const callback = new URL(`http://localhost:${port}/auth/callback`);
    callback.searchParams.set("code", "test-authorization-code");
    callback.searchParams.set("state", "é".repeat(state.length));
    const invalid = await fetch(callback, { signal: AbortSignal.timeout(2_000) });
    assert.equal(invalid.status, 400);
    await invalid.text();
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const pending = request({ hostname: "localhost", port, path: "//[", signal: AbortSignal.timeout(2_000) }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      pending.once("error", reject);
      pending.end();
    });
    assert.equal(malformedStatus, 400);
    callback.searchParams.set("state", state);
    const valid = await fetch(callback, { signal: AbortSignal.timeout(2_000) });
    assert.equal(valid.status, 200);
    await valid.text();
  } finally {
    service.cancel("openai-codex", started.authRequestId);
    context.mock.restoreAll();
  }
});
