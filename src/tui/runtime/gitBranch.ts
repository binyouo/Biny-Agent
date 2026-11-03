/**
 * 读取工作区当前 git 分支，供底部信息区展示。
 *
 * 非 git 目录、git 不可用或读取超时都返回 undefined，界面上只是少一段信息，
 * 不产生错误提示，也不会阻塞 TUI 启动。
 */
import { execFile } from "node:child_process";
import { gitInspectionEnvironment } from "../../tools/git/environment.js";

export async function readGitBranch(cwd: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, env: gitInspectionEnvironment(), timeout: 1000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch && branch !== "HEAD" ? branch : undefined);
      }
    );
  });
}
