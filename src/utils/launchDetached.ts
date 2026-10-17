import { spawn } from "node:child_process";

/** 只等待 OS 接纳启动；应用和终端可以在调用者退出后继续运行。 */
export async function launchDetached(executable: string, args: string[], cwd?: string): Promise<void> {
  const child = spawn(executable, args, { cwd, detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}
