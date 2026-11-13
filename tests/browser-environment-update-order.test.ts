import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { browserPartitionForEnvironment, BrowserEnvironmentStore } from "../src/desktop/browserEnvironments.js";

type ProxyInput = { mode: string };
const unexpected: string[] = [];
function forbidden(name: string): never { unexpected.push(name); throw new Error(`Unexpected boundary: ${name}`); }
const boundary = {
  BrowserWindow: class { constructor() { forbidden("BrowserWindow"); } },
  WebContentsView: class { constructor() { forbidden("WebContentsView"); } },
  clipboard: { writeText: () => forbidden("clipboard") },
  session: { fromPartition: (_partition: string) => ({
    async setProxy(_input: ProxyInput) {}, async closeAllConnections() {}
  }) }
};
Object.assign(globalThis, { __environmentUpdateBoundary: boundary });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/.test(url)
    ? { format: "module", shortCircuit: true, source: "export const { BrowserWindow, WebContentsView, clipboard, session } = globalThis.__environmentUpdateBoundary;" }
    : next(url, context);
} });
const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
const { DesktopCommandService } = await import("../src/desktop/electron/main/DesktopCommandService.js");
hooks.deregister();
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const direct = (name: string) => ({ name, proxy: { mode: "direct" as const } });
const system = (name: string) => ({ name, proxy: { mode: "system" as const } });

for (const mode of ["success", "setProxy", "closeConnections", "compensation", "compensationPersist", "laterFailure", "aba", "differentId", "readiness"] as const) {
  test(`environment updates preserve order: ${mode}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-environment-order-"));
    const file = path.join(root, "environments.json");
    const store = new BrowserEnvironmentStore(file);
    const original = await store.create(system("Original"));
    const other = await store.create(system("Other"));
    const entered = gate(), release = gate();
    const pending: Promise<unknown>[] = [];
    const rename = fs.rename;
    const fetch = globalThis.fetch, connect = net.Socket.prototype.connect, listen = net.Server.prototype.listen;
    unexpected.length = 0;
    globalThis.fetch = async () => forbidden("fetch");
    net.Socket.prototype.connect = (() => forbidden("socket.connect")) as typeof connect;
    net.Server.prototype.listen = (() => forbidden("server.listen")) as typeof listen;
    let compensationWriteFailed = false;
    if (mode === "compensationPersist") fs.rename = async (source, destination) => {
      if (destination === file && !compensationWriteFailed) {
        const content = await fs.readFile(source, "utf8");
        if (content.includes('"Original"')) {
          compensationWriteFailed = true;
          throw Object.assign(new Error("compensation persistence EIO"), { code: "EIO" });
        }
      }
      await rename(source, destination);
    };
    let first = true, blocked = false, call = 0;
    const applied = new Map<string, string>();
    boundary.session.fromPartition = partition => ({
      async setProxy(input) {
        call++;
        if (first) {
          first = false;
          if (mode !== "closeConnections") { entered.resolve(); await release.promise; }
          if (mode === "setProxy" || mode === "compensation" || mode === "compensationPersist") throw new Error("first apply failed");
        } else {
          if (mode === "compensation" && call === 2) throw new Error("compensation apply failed");
          if (mode === "laterFailure" && input.mode === "system") throw new Error("later apply failed");
        }
        applied.set(partition, input.mode);
      },
      async closeAllConnections() {
        if (mode === "closeConnections" && call === 1) {
          entered.resolve(); await release.promise; throw new Error("first close failed");
        }
      }
    });
    const browser = new DesktopBrowserService(async () => forbidden("cookie access"), () => {
      if (blocked) throw new Error("recovery blocked");
    }, undefined, store);
    const commands = new DesktopCommandService({ browser } as ConstructorParameters<typeof DesktopCommandService>[0]);
    const observe = (promise: Promise<unknown>) => {
      const result = promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: String(error) }));
      pending.push(result); return result;
    };
    try {
      const a = observe(browser.updateBrowserEnvironment(original.id, direct("Earlier")));
      await entered.promise;
      let settled = false;
      const b = observe(commands.execute({ action: "browser.env.update", id: mode === "differentId" ? other.id : original.id,
        input: system(mode === "aba" ? "Original" : "Confirmed") })).then(result => { settled = true; return result; });
      // A real subsequent store mutation drains already admitted disk writes. It
      // cannot admit B through the service's per-environment queue.
      await store.create(system("Admission barrier"));
      let guard: ReturnType<typeof setTimeout> | undefined;
      if (mode === "differentId") {
        try {
          await Promise.race([b, new Promise<never>((_, reject) => {
            guard = setTimeout(() => reject(new Error("Independent update failed to drain")), 5000);
          })]);
        } finally { clearTimeout(guard); }
      }
      const settledBeforeRelease = settled;
      const applicationsBeforeRelease = call;
      if (mode === "readiness") blocked = true;
      release.resolve();
      const [ra, rb] = await Promise.all([a, b]);
      const disk = new BrowserEnvironmentStore(file); await disk.load();
      assert.deepEqual(disk.list(), store.list(), "published and persisted state agree");
      const firstFailed = ["setProxy", "closeConnections", "compensation", "compensationPersist"].includes(mode);
      assert.equal(Boolean(ra.error), firstFailed);
      if (mode === "differentId") {
        assert.equal(settledBeforeRelease, true);
        assert.equal(store.get(other.id)?.name, "Confirmed");
        assert.equal(store.get(original.id)?.name, "Earlier");
      } else {
        const expected = mode === "laterFailure" || mode === "readiness" ? "Earlier" : mode === "aba" ? "Original" : "Confirmed";
        assert.equal(store.get(original.id)?.name, expected, "later update survives earlier compensation");
        assert.equal(applicationsBeforeRelease, 1, "same-ID command cannot apply while an earlier apply is pending");
        assert.equal(settledBeforeRelease, false, "same-ID command must wait for proxy application and compensation");
      }
      assert.equal(Boolean(rb.error), mode === "laterFailure" || mode === "readiness");
      if (mode === "readiness") assert.match(rb.error ?? "", /recovery blocked/);
      const targetId = mode === "differentId" ? other.id : original.id;
      assert.equal(applied.get(browserPartitionForEnvironment(targetId)), mode === "laterFailure" || mode === "readiness" ? "direct" : "system");
      if (mode === "compensationPersist") assert.equal(compensationWriteFailed, true);
      blocked = false;
      await browser.updateBrowserEnvironment(original.id, direct("Retry"));
      assert.equal(store.get(original.id)?.name, "Retry", "failures do not poison the update queue");
      const finalDisk = new BrowserEnvironmentStore(file); await finalDisk.load();
      assert.deepEqual(finalDisk.list(), store.list());
      assert.ok(applied.size > 0);
    } finally {
      release.resolve(); await Promise.all(pending);
      fs.rename = rename;
      globalThis.fetch = fetch;
      net.Socket.prototype.connect = connect;
      net.Server.prototype.listen = listen;
      await fs.rm(root, { recursive: true, force: true });
      assert.deepEqual(unexpected, [], "no native/network/cookie boundary was used");
    }
  });
}
