import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";
import { requestComputer } from "../tools/computerUse.js";
import type { WindowTarget } from "./protocol.js";
export const computerDesktopEndpoint = () => path.join(globalConfigDir(), "computer-desktop.json");
export async function computerDesktopConnection(): Promise<{ endpoint: string; token: string } | undefined> {
  let document: string;
  try { document = await readFile(computerDesktopEndpoint(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return z.object({ endpoint: z.string().min(1), token: z.string().min(32) }).strict().parse(JSON.parse(document));
}
export async function notifyDesktopComputerActivity(target: WindowTarget): Promise<void> {
  const endpoint = await computerDesktopConnection(); if (endpoint) await requestComputer(endpoint, "external_activity", target);
}
