import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectProjectContext } from "../src/project/ProjectContext.js";

const fifoSkip = process.platform === "win32" || typeof constants.O_NONBLOCK !== "number";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-project-fifo-")));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const fileName of ["README.md", "package.json", "tsconfig.json"] as const) {
  await test(`${fileName} FIFO is skipped without a writer or a content read`, { skip: fifoSkip }, async (t) => {
    await fixture(async (root) => {
      const target = path.join(root, fileName);
      execFileSync("mkfifo", [target]);
      const before = await fs.lstat(target);
      assert.equal(before.isFIFO(), true);
      const originalOpen = fs.open;
      const originalReadFile = fs.readFile;
      let unsafeReads = 0;
      let opened = 0;
      let closed = 0;
      let dataReads = 0;
      t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === target) {
          unsafeReads++;
          // Baseline reproduction lives outside this suite. Never let a regression
          // issue its original uninterruptible FIFO open inside the test process.
          return Promise.reject(new Error("unsafe path-based FIFO read was intercepted"));
        }
        return Reflect.apply(originalReadFile, fs, args);
      });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) !== target) return Reflect.apply(originalOpen, fs, args);
        const flags = args[1];
        assert.equal(typeof flags, "number");
        assert.ok(Number(flags) & constants.O_NONBLOCK, "FIFO validation must not wait for a writer");
        assert.ok(Number(flags) & constants.O_NOFOLLOW);
        assert.equal(Number(flags) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
        const handle = await Reflect.apply(originalOpen, fs, args);
        opened++;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); closed++; });
        t.mock.method(handle, "readFile", () => { dataReads++; throw new Error("nonregular content must not be read"); });
        t.mock.method(handle, "read", () => { dataReads++; throw new Error("nonregular content must not be read"); });
        return handle;
      });
      try {
        const context = await collectProjectContext(root, []);
        assert.equal(context[fileName === "README.md" ? "readme" : fileName === "package.json" ? "packageJson" : "tsconfig"], undefined);
        assert.equal(unsafeReads, 0, "optional summaries must not issue a blocking path-based read on a FIFO");
        assert.deepEqual({ opened, closed, dataReads }, { opened: 1, closed: 1, dataReads: 0 });
        const after = await fs.lstat(target);
        assert.equal(after.ino, before.ino);
        assert.equal(after.isFIFO(), true);
      } finally { t.mock.restoreAll(); }
    });
  });
}

await test("pre-aborted project collection opens no files and preserves the reason", async (t) => {
  const reason = new Error("cancel before project collection");
  const open = t.mock.method(fs, "open", () => { throw new Error("must not open"); });
  await assert.rejects(collectProjectContext("unused", [], AbortSignal.abort(reason)), (error: unknown) => error === reason);
  assert.equal(open.mock.callCount(), 0);
});

for (const stage of ["opened", "read"] as const) {
  await test(`cancellation after ${stage} closes the summary descriptor and preserves the reason`, async (t) => {
    await fixture(async (root) => {
      const target = path.join(root, "README.md");
      await fs.writeFile(target, "project description");
      const controller = new AbortController();
      const reason = new Error(`cancel at ${stage}`);
      const originalOpen = fs.open;
      let opened = 0;
      let closed = 0;
      let reads = 0;
      let finishClose!: () => void;
      const closedSignal = new Promise<void>((resolve) => { finishClose = resolve; });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await Reflect.apply(originalOpen, fs, args);
        if (String(args[0]) !== target) return handle;
        opened++;
        const close = handle.close.bind(handle);
        const readFile = handle.readFile.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); closed++; finishClose(); });
        t.mock.method(handle, "readFile", async (...readArgs: Parameters<typeof handle.readFile>) => {
          reads++;
          if (stage === "read") controller.abort(reason);
          return Reflect.apply(readFile, handle, readArgs);
        });
        if (stage === "opened") controller.abort(reason);
        return handle;
      });
      try {
        await assert.rejects(collectProjectContext(root, [], controller.signal), (error: unknown) => error === reason);
        // Other parallel summary branches may propagate cancellation first.
        // The opened branch must still drain its descriptor, without data reads.
        await closedSignal;
        assert.deepEqual({ opened, closed, reads }, { opened: 1, closed: 1, reads: stage === "read" ? 1 : 0 });
      } finally { t.mock.restoreAll(); }
    });
  });
}

await test("descriptor validation and read failures close once and leave summaries optional", async (t) => {
  await fixture(async (root) => {
    const target = path.join(root, "README.md");
    await fs.writeFile(target, "project description");
    for (const stage of ["stat", "readFile"] as const) {
      const originalOpen = fs.open;
      let opened = 0;
      let closed = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await Reflect.apply(originalOpen, fs, args);
        if (String(args[0]) !== target) return handle;
        opened++;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); closed++; });
        t.mock.method(handle, stage, () => { throw Object.assign(new Error("synthetic read failure"), { code: "EIO" }); });
        return handle;
      });
      try {
        assert.equal((await collectProjectContext(root, [])).readme, undefined);
        assert.deepEqual({ opened, closed }, { opened: 1, closed: 1 });
      } finally { t.mock.restoreAll(); }
    }
  });
});

await test("regular summaries retain full JSON reads and UTF-8 replacement plus README character slicing", async () => {
  await fixture(async (root) => {
    // The opener must not inherit the file editing tool's 1 MiB content cap.
    await fs.writeFile(path.join(root, "package.json"), `${" ".repeat(1024 * 1024 + 1)}{"name":"large-project"}`);
    const bytes = Buffer.concat([Buffer.from("😀中文\n"), Buffer.from([0xff]), Buffer.from("x".repeat(3100))]);
    await fs.writeFile(path.join(root, "README.md"), bytes);
    await fs.writeFile(path.join(root, "tsconfig.json"), '{/* comment */"compilerOptions":{"strict":true},}');
    const result = await collectProjectContext(root, []);
    assert.equal(result.packageJson?.name, "large-project");
    assert.equal(result.readme, bytes.toString("utf8").slice(0, 3000));
    assert.equal(result.tsconfig?.compilerOptions.strict, true);
  });
});

await test("canonical in-workspace aliases remain readable while escaping aliases remain omitted", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "description.txt"), "alias description");
    await fs.symlink("description.txt", path.join(workspace, "README.md"));
    assert.equal((await collectProjectContext(workspace, [])).readme, "alias description");
    await fs.rm(path.join(workspace, "README.md"));
    await fs.writeFile(path.join(root, "outside.txt"), "outside description");
    await fs.symlink("../outside.txt", path.join(workspace, "README.md"));
    assert.equal((await collectProjectContext(workspace, [])).readme, undefined);
  });
});
