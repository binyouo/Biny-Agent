import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [role, endpoint, token, phase, exitKind] = process.argv.slice(2);
if (role === "child") process.on("SIGTERM", () => {});
const control = createConnection(endpoint);
control.on("error", () => process.exit(2));
control.on("close", () => process.exit(0));
await new Promise((resolve) => control.once("connect", resolve));
control.write(JSON.stringify({ token, role, pid: process.pid }) + "\n");
const commands = createInterface({ input: control });
commands.on("line", (line) => {
  if (line === "cleanup") process.exit(0);
  if (line === "exit" && role === "leader") {
    if (exitKind === "signal") process.kill(process.pid, "SIGTERM");
    else process.exit(7);
  }
});

if (role === "leader") {
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  let spawned = false;
  const prepareExit = () => {
    if (spawned) throw new Error("Fixture child already exists");
    spawned = true;
    // Inherit the ACP pipes so leader exit, not premature EOF, closes the client.
    // detached is deliberately omitted: this child must remain in the ACP group.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", endpoint, token, phase, exitKind], {
      stdio: ["ignore", process.stdout, process.stderr]
    });
    child.once("error", () => process.exit(3));
  };
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (phase === "initialize") prepareExit();
      else send(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (message.method === "session/new") send(message.id, { sessionId: "exit-group-session" });
    else if (message.method === "session/prompt") prepareExit();
  }
}
