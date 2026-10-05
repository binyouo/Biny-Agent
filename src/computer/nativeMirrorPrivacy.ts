import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface NativeMirrorPrivacy { active: boolean; epoch: string }

/** 跨进程镜像的可见期；不启动 daemon，不读取图片或应用内容。 */
export async function readNativeMirrorPrivacy(directory = path.join(os.tmpdir(), `biny-mirror-privacy-${process.getuid?.() ?? 0}`)): Promise<NativeMirrorPrivacy> {
  if (process.platform !== "darwin") return { active: false, epoch: "" };
  let entries: string[];
  try { entries = (await readdir(directory)).filter(name => /^[1-9][0-9]*\.json$/u.test(name)).sort(); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { active: false, epoch: "" } : { active: true, epoch: "registry-unavailable" };
  }
  try {
    if (entries.length > 4096) return { active: true, epoch: "registry-budget" };
    let active = false;
    const epochs: string[] = [];
    for (const name of entries) {
      const pid = Number(name.slice(0, -5));
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
      const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 4096 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return { active: true, epoch: "registry-invalid" };
        const value = JSON.parse(await file.readFile("utf8")) as { pid?: unknown; active?: unknown; epoch?: unknown };
        if (value.pid !== pid || typeof value.active !== "boolean" || typeof value.epoch !== "string" || value.epoch.length > 64) return { active: true, epoch: "registry-invalid" };
        active ||= value.active;
        epochs.push(`${pid}:${value.epoch}`);
      } finally { await file.close(); }
    }
    return { active, epoch: epochs.join(";") };
  } catch {
    return { active: true, epoch: "registry-unavailable" };
  }
}
