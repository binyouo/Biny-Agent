import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";

for (const failure of [undefined, "directory", "file", "replacement", "hardlink", "nonempty", "side-file"] as const) {
  test(`Windows file lock ${failure ? `refuses ${failure} failure` : "uses DACL instead of synthetic POSIX permissions"}`, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-windows-lock-")));
    const authorityPath = path.join(root, "state.lock.authority.sqlite");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const systemRoot = process.env.SystemRoot;
    const denied = new Error("synthetic DACL denial");
    const calls: { target: string; kind: string }[] = [];
    if (failure === "hardlink") {
      await fs.writeFile(path.join(root, "target"), "");
      await fs.link(path.join(root, "target"), authorityPath);
    } else if (failure === "nonempty") await fs.writeFile(authorityPath, "existing data");
    else if (failure === "side-file") await fs.writeFile(`${authorityPath}-wal`, "existing journal");
    const realStat = filesystem.lstatSync;
    const stat = context.mock.method(filesystem, "lstatSync", (...args: Parameters<typeof filesystem.lstatSync>) => {
      const result = realStat(...args);
      if (args[0] === authorityPath) result.mode = Number(result.mode) | 0o066;
      return result;
    });
    const exec = context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
      const options = args[2] as { env: NodeJS.ProcessEnv };
      const target = options.env.BINY_IPC_PRIVATE_PATH!;
      const kind = options.env.BINY_IPC_PATH_KIND!;
      calls.push({ target, kind });
      if (failure === "replacement" && kind === "file") {
        filesystem.renameSync(authorityPath, `${authorityPath}.original`);
        filesystem.writeFileSync(authorityPath, "", { mode: 0o600 });
      }
      queueMicrotask(() => (args[3] as (error: Error | null) => void)(failure === kind ? denied : null));
      return new childProcess.ChildProcess();
    });
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.SystemRoot = "C:\\Windows";
    syncBuiltinESMExports();
    let entered = false;
    try {
      const operation = withLocalFileWriteLock(root, "state.lock", async () => {
        entered = true;
        await fs.writeFile(path.join(root, "result"), "protected operation");
      });
      if (failure === "replacement") await assert.rejects(operation, /authority changed/u);
      else if (failure === "hardlink" || failure === "nonempty" || failure === "side-file") {
        await assert.rejects(operation, /authority/u);
        assert.deepEqual(calls, [{ target: root, kind: "directory" }]);
        if (failure === "hardlink") assert.equal((await fs.stat(authorityPath)).nlink, 2);
        else if (failure === "nonempty") assert.equal(await fs.readFile(authorityPath, "utf8"), "existing data");
        else assert.equal(await fs.readFile(`${authorityPath}-wal`, "utf8"), "existing journal");
      } else if (failure) await assert.rejects(operation, (error: unknown) => error instanceof Error && error.cause === denied);
      else {
        await operation;
        assert.deepEqual(calls, [{ target: root, kind: "directory" }, { target: authorityPath, kind: "file" }]);
        assert.equal(await fs.readFile(path.join(root, "result"), "utf8"), "protected operation");
        assert.equal((await fs.stat(authorityPath)).size, 0);
      }
      assert.equal(entered, failure === undefined);
      await assert.rejects(fs.access(path.join(root, "state.lock")), { code: "ENOENT" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
      stat.mock.restore();
      exec.mock.restore();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
