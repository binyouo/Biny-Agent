import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** A supervision wake accepts one literal CLI invocation, without shell expansion or composition. */
export function assertSupervisionCommand(command: string, background?: boolean): void {
  if (background) throw new Error("Plan supervision cannot start a background shell.");
  const [group, action, ...args] = literalBinyCommand(command);
  if (group !== "plan" || (action !== "status" && action !== "update")) throw new Error("Plan supervision allows only plan status and plan update.");
  const parsed = parseArgs({ args, strict: true, allowPositionals: true, options: {
    json: { type: "boolean" }, session: { type: "string" }, input: { type: "string" }, revision: { type: "string" }
  } });
  if (action === "status" ? parsed.positionals.length !== 1 || parsed.values.input !== undefined : parsed.positionals.length !== 0 || parsed.values.input === undefined) {
    throw new Error("Invalid plan supervision command arguments.");
  }
}

/** Compound shell work must still count as activity when it also reads a goal. */
export function isGoalControlCommand(command: string): boolean {
  try {
    const [group, action, ...args] = literalBinyCommand(command);
    if (group !== "goal" || (action !== "show" && action !== "update")) return false;
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, options: {
      json: { type: "boolean" }, session: { type: "string" }, input: { type: "string" }
    } });
    return action === "show" ? parsed.values.input === undefined : parsed.values.input !== undefined;
  } catch { return false; }
}

function literalBinyCommand(command: string): string[] {
  const words: string[] = [];
  let offset = 0;
  const word = /(?:'[^']*'|\\'|[A-Za-z0-9_./:=,@+-])+/uy;
  while (offset < command.length) {
    const whitespace = /^\s+/u.exec(command.slice(offset));
    if (whitespace) offset += whitespace[0].length;
    if (offset === command.length) break;
    word.lastIndex = offset;
    const match = word.exec(command);
    if (!match) throw new Error("Plan supervision requires one literal biny plan command.");
    words.push(match[0].replace(/'([^']*)'|\\'/gu, (_match, quoted: string | undefined) => quoted ?? "'"));
    offset = word.lastIndex;
    if (offset < command.length && !/\s/u.test(command[offset]!)) throw new Error("Shell composition is unavailable during plan supervision.");
  }
  if (words[0] === "biny") words.shift();
  else {
    const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
    const sourceCli = cli.replace(/\.js$/u, ".ts");
    const sourceInvocation = words[1] === "--import" ? [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), sourceCli] : [];
    const compiledInvocation = [process.execPath, cli];
    const prefix = [sourceInvocation, compiledInvocation].find(candidate => candidate.length > 0 && candidate.every((part, index) => path.normalize(words[index] ?? "") === path.normalize(part)));
    if (!prefix) throw new Error("Plan supervision can execute only the Biny CLI.");
    words.splice(0, prefix.length);
  }
  return words;
}
