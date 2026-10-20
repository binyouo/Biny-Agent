import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "vendor/rtk/manifest.json"), "utf8"));
const arch = process.argv[2] ?? process.arch;
const asset = manifest.assets[`${process.platform}-${arch}`];
if (!asset) throw new Error(`No pinned RTK binary for ${process.platform}-${arch}.`);
const cache = path.join(root, "node_modules/.cache/biny/rtk", `v${manifest.version}`);
await mkdir(cache, { recursive: true });
const archive = path.join(cache, asset.file);
const temporary = await mkdtemp(path.join(cache, "prepare-"));
try {
  if (!existsSync(archive)) {
    const download = path.join(temporary, asset.file);
    try {
      execFileSync("curl", ["--fail", "--location", "--retry", "2", "--max-time", "120", `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${asset.file}`, "--output", download], { stdio: "pipe", timeout: 150_000 });
    } catch {
      execFileSync("gh", ["release", "download", `v${manifest.version}`, "--repo", manifest.repository, "--pattern", asset.file, "--dir", temporary, "--clobber"], { stdio: "pipe", timeout: 150_000 });
    }
    if (createHash("sha256").update(await readFile(download)).digest("hex") !== asset.sha256) throw new Error("RTK download checksum mismatch.");
    await rename(download, archive);
  }
  if (createHash("sha256").update(await readFile(archive)).digest("hex") !== asset.sha256) throw new Error("RTK cached archive checksum mismatch; remove the cached archive and rebuild.");
  const executable = process.platform === "win32" ? "rtk.exe" : "rtk";
  // Extract only the pinned executable, never arbitrary archive paths.
  execFileSync("tar", ["-xf", archive, "-C", temporary, executable], { stdio: "pipe" });
  const output = path.join(root, "out/rtk", arch);
  await mkdir(output, { recursive: true });
  await copyFile(path.join(temporary, executable), path.join(output, executable));
  await chmod(path.join(output, executable), 0o755);
  await copyFile(path.join(root, "vendor/rtk/LICENSE"), path.join(output, "LICENSE"));
  await writeFile(path.join(output, "provenance.json"), JSON.stringify({ version: manifest.version, platform: process.platform, arch, ...asset }, null, 2) + "\n");
  console.log(`Prepared RTK ${manifest.version} for ${process.platform}-${arch}.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
