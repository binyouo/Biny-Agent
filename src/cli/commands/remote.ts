import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Command } from "commander";
import { connectOrSpawnRuntimeHost, connectRuntimeHost } from "../../runtime/RuntimeHost.js";
import { createRemotePeerApi } from "../../remote/api.js";
import { generateConnectCode } from "../../remote/crypto.js";
import { remotePairingUrl, remoteRelayUrl } from "../../remote/address.js";
import { runRemoteTunnel } from "../../remote/tunnel.js";

export function registerRemoteCommands(program: Command, workspaceRoot: string, wrap: (action: () => Promise<void>) => () => Promise<void>): void {
  const remote = program.command("remote").description("Connect a native mobile client through an encrypted relay");
  remote.command("run").description("Keep encrypted phone access open for the current workspace; Ctrl+C revokes this pairing")
    .requiredOption("--relay <origin>", "self-hosted HTTPS relay origin")
    .option("--json", "print one pairing record; connection status goes to stderr")
    .action((options: { relay: string; json?: boolean }) => wrap(async () => {
      const relay = remoteRelayUrl(options.relay).origin;
      const code = generateConnectCode();
      const pairingUrl = remotePairingUrl(relay, code);
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let client: Awaited<ReturnType<typeof connectOrSpawnRuntimeHost>> = undefined;
      try {
        client = await connectOrSpawnRuntimeHost(workspaceRoot, { workspaceRoot, surface: "cli", clientId: `remote-${randomUUID()}`, keepAlive: true, resumeInterrupted: false });
        if (!client) throw new Error("Runtime Host is unavailable.");
        await client.waitForReady();
        let announced = false;
        await runRemoteTunnel({ relay, code, registrationKey: process.env.BINY_RELAY_REGISTRATION_KEY,
          createPeer: emit => createRemotePeerApi({
            list: async () => [{ id: "workspace", name: path.basename(workspaceRoot) || "workspace", path: workspaceRoot, workspaceRoot }],
            attach: async () => {
              const attached = await connectRuntimeHost(workspaceRoot, { clientId: `remote-${randomUUID()}`, surface: "cli", keepAlive: true });
              if (!attached) throw new Error("Runtime Host is unavailable.");
              await attached.waitForReady();
              return { workspaceRoot, client: attached };
            }
          }, emit),
          onStatus(status) {
            if (status === "connected" && !announced) {
              announced = true;
              const pairing = { relay, code, pairingUrl, workspace: workspaceRoot };
              console.log(options.json ? JSON.stringify(pairing) : `Biny remote access is ready. Keep this terminal running.\nRelay: ${relay}\nConnect code: ${code}\nPairing link: ${pairingUrl}\nCtrl+C stops access. Restarting creates a new code.`);
            } else console.error(`Remote access: ${status}.`);
          }
        }, controller.signal);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await client?.close();
      }
    })());
}
