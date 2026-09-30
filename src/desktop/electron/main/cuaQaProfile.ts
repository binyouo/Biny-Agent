/** Explicit QA launch isolation; prepared configuration must disable passive collection. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
interface QaApp { setPath(name: "userData", value: string): void; getName?(): string }
export function applyCuaQaProfile(app: QaApp, env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.BINY_CUA_QA_PROFILE;
  if (!profile) {
    if (app.getName?.() === "Biny Cua QA") throw new Error("Biny Cua QA requires an explicit isolated BINY_CUA_QA_PROFILE; default profile is forbidden");
    return false;
  }
  if (!path.isAbsolute(profile)) throw new Error("Cua QA profile must be absolute");
  const agent = path.join(profile, "agent");
  z.object({ activity: z.object({ enabled: z.literal(false), inputMonitoringEnabled: z.literal(false), browserPollIntervalMs: z.literal(0) }) }).parse(JSON.parse(readFileSync(path.join(agent, "config.json"), "utf8")));
  env.BINY_AGENT_DIR = agent;
  app.setPath("userData", path.join(profile, "desktop"));
  return true;
}
