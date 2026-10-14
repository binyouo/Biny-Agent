import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("辅助应用构建产物声明并包含可读取的应用图标，原生动作测试未覆盖系统权限列表使用的资源", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-computer-bundle-"));
  try {
    for (const name of ["scripts", "build", "bin"]) await mkdir(path.join(directory, name));
    await copyFile("scripts/build-activity-sidecar.mjs", path.join(directory, "scripts/build-activity-sidecar.mjs"));
    await copyFile("build/icon.icns", path.join(directory, "build/icon.icns"));
    // 只隔离编译和签名工具；实际运行打包脚本，核对生成的应用资源。
    await writeFile(path.join(directory, "bin/xcrun"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; touch "$1"; exit 0; fi
  shift
done
exit 1
`, { mode: 0o755 });
    await writeFile(path.join(directory, "bin/codesign"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    execFileSync(process.execPath, [path.join(directory, "scripts/build-activity-sidecar.mjs")], {
      env: { ...process.env, PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}` }, timeout: 10_000
    });
    const contents = path.join(directory, "out/native/computer-use.app/Contents");
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")], { encoding: "utf8" }));
    assert.equal(plist.CFBundleIdentifier, "com.biny.computer-use");
    assert.equal(plist.LSUIElement, true);
    assert.equal(plist.CFBundleIconFile, "icon.icns");
    const icon = await readFile(path.join(contents, "Resources", plist.CFBundleIconFile));
    assert.deepEqual(icon, await readFile("build/icon.icns"));
    execFileSync("/usr/bin/sips", ["-s", "format", "png", path.join(contents, "Resources", plist.CFBundleIconFile), "--out", path.join(directory, "icon.png")], { timeout: 10_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
