import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";

function fixture() {
  const requests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const service = new DesktopMcpService({} as never, {} as never, {} as never,
    () => new Promise<Response>((resolve, reject) => { requests.push({ resolve, reject }); }));
  const response = () => new Response(JSON.stringify({ servers: [{ id: "fixture", name: "Fixture",
    installations: [{ name: "Local", config: { command: "fixture" } }] }] }));
  return { service, requests, response };
}

test("concurrent marketplace refresh callers share one request and independent snapshots", async () => {
  const { service, requests, response } = fixture();
  const first = service.refreshCatalog();
  const second = service.refreshCatalog();
  requests[0]!.resolve(response());
  // Settle all requests on the old implementation before checking the regression.
  requests[1]?.reject(new Error("obsolete request failed"));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests.length, 1);
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  a.entries.length = 0;
  assert.equal(b.entries.length, 1);
  assert.equal(service.catalog().entries.length, 1);
});

test("failed initial refresh releases the flight so a later retry can succeed", async () => {
  const { service, requests, response } = fixture();
  const failed = service.refreshCatalog();
  requests[0]!.reject(new Error("offline"));
  assert.equal((await failed).status, "error");
  const retry = service.refreshCatalog();
  assert.equal(requests.length, 2);
  requests[1]!.resolve(response());
  assert.equal((await retry).status, "ready");
});

test("concurrent failed refresh preserves the last good catalog and permits another refresh", async () => {
  const { service, requests, response } = fixture();
  const initial = service.refreshCatalog();
  requests[0]!.resolve(response());
  await initial;
  const first = service.refreshCatalog();
  const second = service.refreshCatalog();
  requests[1]!.reject(new Error("offline"));
  requests[2]?.reject(new Error("offline"));
  const results = await Promise.all([first, second]);
  assert.equal(requests.length, 2);
  for (const result of results) {
    assert.equal(result.status, "stale");
    assert.equal(result.entries.length, 1);
  }
  const retry = service.refreshCatalog();
  requests[2]!.resolve(response());
  assert.equal((await retry).status, "ready");
});
