/** 单实例启动参数只传递引用意图；实际对象与项目权限由 Desktop 引用服务再次验证。 */
import { parseLocalReferenceUri } from "../../../session/localReferences.js";

export function parseDesktopReferenceLaunch(argv: readonly string[]): { uri: string; projectId: string } | undefined {
  const uri = argv.find((arg) => arg.startsWith("--biny-ref="))?.slice("--biny-ref=".length);
  const projectId = argv.find((arg) => arg.startsWith("--biny-project="))?.slice("--biny-project=".length);
  if (!uri || !projectId || !/^[A-Za-z0-9_-]{1,64}$/u.test(projectId)) return undefined;
  try { parseLocalReferenceUri(uri); }
  catch { return undefined; }
  return { uri, projectId };
}
