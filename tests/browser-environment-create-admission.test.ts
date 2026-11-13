import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { randomUUID } from "node:crypto";
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

for (const window of ["persist", "proxy"] as const) {
  for (const outcome of ["success", "failure", "readiness", "compensationFailure"] as const) {
    if (window === "persist" && outcome === "compensationFailure") continue;
    test(`create/update admission: ${window}/${outcome}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-create-admission-"));
      const file = path.join(root, "environments.json");
      const store = new BrowserEnvironmentStore(file);
      const other = await store.create(system("Other"));
      const entered = gate(), release = gate();
      const pending: Promise<unknown>[] = [];
      const rename = fs.rename, fetch = globalThis.fetch, connect = net.Socket.prototype.connect, listen = net.Server.prototype.listen;
      const applied = new Map<string, string>();
      let blocked = false, firstPersist = true, firstProxy = true, compensationFailed = false;
      let selectedId = "", updateAdmissions = 0;
      const realUpdate = store.update.bind(store);
      store.update = async (id, input) => {
        if (id === selectedId) updateAdmissions++;
        return await realUpdate(id, input);
      };
      unexpected.length = 0;
      globalThis.fetch = async () => forbidden("fetch");
      net.Socket.prototype.connect = (() => forbidden("socket.connect")) as typeof connect;
      net.Server.prototype.listen = (() => forbidden("server.listen")) as typeof listen;
      fs.rename = async (source, destination) => {
        if (destination === file && firstPersist) {
          firstPersist = false;
          if (window === "persist") {
            entered.resolve(); await release.promise;
            if (outcome === "failure") throw Object.assign(new Error("create persist EIO"), { code: "EIO" });
          }
        } else if (destination === file && outcome === "compensationFailure" && !compensationFailed) {
          const saved = JSON.parse(await fs.readFile(source, "utf8")) as { id: string }[];
          if (!saved.some(item => item.id === selectedId)) {
            compensationFailed = true;
            throw Object.assign(new Error("delete compensation EIO"), { code: "EIO" });
          }
        }
        await rename(source, destination);
      };
      boundary.session.fromPartition = partition => ({
        async setProxy(input) {
          if (firstProxy) {
            firstProxy = false;
            if (window === "proxy") {
              entered.resolve(); await release.promise;
              if (outcome === "failure" || outcome === "compensationFailure") throw new Error("create proxy failed");
            }
          }
          applied.set(partition, input.mode);
        }, async closeAllConnections() {}
      });
      const browser = new DesktopBrowserService(async () => forbidden("cookies"), () => {
        if (blocked) throw new Error("recovery blocked");
      }, undefined, store);
      const commands = new DesktopCommandService({ browser } as ConstructorParameters<typeof DesktopCommandService>[0]);
      const observe = (promise: Promise<unknown>) => {
        const result = promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: String(error) }));
        pending.push(result); return result;
      };
      try {
        const creating = observe(commands.execute({ action: "browser.env.create", input: direct("Creating") }));
        await entered.promise;
        const selected = browser.browserEnvironmentSnapshot().find(item => item.name === "Creating");
        assert.ok(selected, "discover ID through the public snapshot, never a private mutation");
        selectedId = selected.id;
        const b = observe(commands.execute({ action: "browser.env.update", id: selectedId, input: system("Second") }));
        const c = observe(commands.execute({ action: "browser.env.update", id: selectedId, input: {
          name: "Final", proxy: { mode: "fixed_servers", proxyRules: "http://synthetic.invalid:8080" }
        } }));
        // Drain promise jobs without releasing the real filesystem/proxy gate.
        await nextTurn();
        const admittedBeforeRelease = updateAdmissions;
        if (window === "proxy") {
          // Existing environments must remain usable while this creation is pending.
          const independent = observe(commands.execute({ action: "browser.env.update", id: other.id, input: system("Other confirmed") }));
          let guard: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([independent, new Promise<never>((_, reject) => {
              guard = setTimeout(() => reject(new Error("Independent environment was blocked")), 5000);
            })]);
            assert.equal(result.error, undefined);
          } finally { clearTimeout(guard); }
          const disk = new BrowserEnvironmentStore(file); await disk.load();
          assert.equal(disk.get(other.id)?.name, "Other confirmed");
        }
        if (outcome === "readiness") blocked = true;
        release.resolve();
        const [aResult, bResult, cResult] = await Promise.all([creating, b, c]);
        const disk = new BrowserEnvironmentStore(file); await disk.load();
        assert.deepEqual(disk.list(), store.list());
        const expectedName = outcome === "failure" ? undefined : outcome === "readiness" ? "Creating" : "Final";
        assert.equal(disk.get(selectedId)?.name, expectedName);
        assert.equal(admittedBeforeRelease, 0, "updates must not enter the store before creation settles");
        assert.equal(Boolean(aResult.error), outcome === "failure" || outcome === "compensationFailure");
        assert.equal(Boolean(bResult.error), outcome === "failure" || outcome === "readiness");
        assert.equal(Boolean(cResult.error), outcome === "failure" || outcome === "readiness");
        if (outcome === "readiness") assert.match(cResult.error ?? "", /recovery blocked/);
        if (outcome === "compensationFailure") assert.equal(compensationFailed, true);
        if (expectedName === "Final") assert.equal(applied.get(browserPartitionForEnvironment(selectedId)), "fixed_servers");
        blocked = false;
        if (expectedName) {
          await browser.updateBrowserEnvironment(selectedId, system("Retry"));
          assert.equal(store.get(selectedId)?.name, "Retry");
        } else {
          await assert.rejects(browser.updateBrowserEnvironment(selectedId, system("No resurrection")), /不存在/);
          const retry = await browser.createBrowserEnvironment(system("Retry creation"));
          assert.notEqual(retry.id, selectedId);
        }
        const finalDisk = new BrowserEnvironmentStore(file); await finalDisk.load();
        assert.deepEqual(finalDisk.list(), store.list());
      } finally {
        release.resolve(); await Promise.all(pending);
        fs.rename = rename; globalThis.fetch = fetch;
        net.Socket.prototype.connect = connect; net.Server.prototype.listen = listen;
        await fs.rm(root, { recursive: true, force: true });
        assert.deepEqual(unexpected, []);
      }
    });
  }
}

test("reserved IDs are validated and collision-safe without changing default creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-reserved-id-"));
  const file = path.join(root, "environments.json");
  try {
    const store = new BrowserEnvironmentStore(file);
    const id = randomUUID();
    assert.equal((await store.create(system("Reserved"), id)).id, id);
    const bytes = await fs.readFile(file);
    await assert.rejects(store.create(system("Collision"), id), /ID/);
    await assert.rejects(store.create(system("Invalid"), "invalid"));
    assert.deepEqual(await fs.readFile(file), bytes);
    const other = await store.create(system("Default generated"));
    assert.notEqual(other.id, id);
    const disk = new BrowserEnvironmentStore(file); await disk.load();
    assert.deepEqual(disk.list(), store.list());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
