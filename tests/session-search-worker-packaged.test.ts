import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { SessionSearchStore } from "../src/session/searchIndexStore.js";
import type { SessionSearchWorkerLease } from "../src/session/searchIndexWorkerClient.js";

for (const layout of ["chunks", "flat"] as const) {
  test(`compiled history worker client indexes and closes from ${layout} layout`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-packaged-"));
    const agentRoot = path.join(root, "agent");
    const store = new SessionSearchStore(agentRoot);
    let lease: SessionSearchWorkerLease | undefined;
    try {
      const clientName = layout === "chunks" ? "chunks/client" : "client";
      await build({
        entryPoints: {
          [clientName]: fileURLToPath(new URL("../src/session/searchIndexWorkerClient.ts", import.meta.url)),
          searchIndexWorker: fileURLToPath(new URL("../src/session/searchIndexWorker.ts", import.meta.url))
        },
        outdir: root, bundle: true, platform: "node", format: "esm", logLevel: "silent"
      });
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const client = await import(pathToFileURL(path.join(root, `${clientName}.js`)).href) as {
        acquireSessionSearchWorker(root: string): SessionSearchWorkerLease;
      };
      lease = client.acquireSessionSearchWorker(agentRoot);
      const file = path.join(root, "session.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "user_message", messageId: "retained", content: "packagedhistorymarker" })}\n`);
      assert.equal(await lease.index("session", file, new AbortController().signal), 1);
      assert.equal(store.search("packagedhistorymarker")[0]?.messageId, "retained");
      assert.equal(await lease.index("session", file, new AbortController().signal), 0);
    } finally {
      await lease?.release();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
