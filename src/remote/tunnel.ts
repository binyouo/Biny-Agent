import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";
import { acceptRemoteHandshake, routingToken, type RemoteCipher } from "./crypto.js";
import { remoteRequestSchema, type RemotePeerApi } from "./api.js";
import { redactSecrets } from "../utils/secrets.js";
import { remoteRelayUrl } from "./address.js";

interface TunnelOptions {
  relay: string;
  code: string;
  registrationKey?: string;
  createPeer(emit: (value: unknown) => void): RemotePeerApi;
  onStatus?(status: "connected" | "reconnecting"): void;
  onPeerCount?(count: number): void;
}

interface Peer {
  cipher?: RemoteCipher;
  api?: RemotePeerApi;
  input: Promise<void>;
  output: Promise<void>;
  queued: number;
  outputBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

const envelope = z.object({ t: z.string(), id: z.string().min(1).max(128).optional(), path: z.string().max(4096).optional(), s: z.string().max(1_600_000).optional() }).passthrough();
const terminalCodes = new Set([4000, 4002, 4003, 4401]);

export async function runRemoteTunnel(options: TunnelOptions, signal: AbortSignal): Promise<void> {
  const url = remoteRelayUrl(options.relay);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent";
  const tokenHash = createHash("sha256").update(await routingToken(options.code)).digest("hex");
  url.searchParams.set("th", tokenHash);
  let attempts = 0;
  while (!signal.aborted) {
    const result = await connect(url, tokenHash, options, signal);
    if (signal.aborted) return;
    if (terminalCodes.has(result.code)) throw new Error(result.code === 4000 ? "Remote pairing is already registered elsewhere. Restart with a new connect code." : "Relay registration was rejected. Check the relay registration key or token.");
    attempts = result.registered ? 0 : attempts + 1;
    options.onStatus?.("reconnecting");
    try { await delay(Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)), undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

async function connect(url: URL, tokenHash: string, options: TunnelOptions, signal: AbortSignal): Promise<{ code: number; registered: boolean }> {
  const socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10_000, followRedirects: false });
  const peers = new Map<string, Peer>();
  const pending = new Set<Promise<void>>();
  let registered = false;
  const drop = (id: string): void => {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    clearTimeout(peer.timer);
    const closing = peer.api?.close();
    if (closing) {
      const done = Promise.resolve(closing).then(() => undefined, () => undefined);
      pending.add(done);
      void done.finally(() => pending.delete(done));
    }
    if (peer.api) options.onPeerCount?.([...peers.values()].filter(value => value.api).length);
  };
  const send = (value: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Remote connection closed.");
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.terminate(); throw new Error("Remote connection stalled."); }
    socket.send(JSON.stringify(value));
  };
  const closePeer = (id: string, expected: Peer): void => {
    if (peers.get(id) !== expected) return;
    drop(id);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "wclose", id, code: 1008, reason: "Remote channel closed" }), error => { if (error) socket.terminate(); });
  };
  const encryptedSend = (id: string, peer: Peer, value: unknown): void => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    peer.outputBytes += bytes;
    if (peer.outputBytes > 2 * 1024 * 1024) { closePeer(id, peer); return; }
    peer.output = peer.output.then(async () => {
      if (peers.get(id) !== peer || !peer.cipher) return;
      const packet = await peer.cipher.encrypt(value);
      if (peers.get(id) === peer) send({ t: "wmsg", id, s: packet });
    }).catch(() => closePeer(id, peer)).finally(() => { peer.outputBytes -= bytes; });
  };
  const timeout = setTimeout(() => socket.terminate(), 10_000);
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    if (socket.readyState === WebSocket.OPEN) { alive = false; socket.ping(); }
  }, 25_000);
  const stop = (): void => socket.terminate();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  socket.on("pong", () => { alive = true; });
  socket.on("error", () => undefined);
  socket.on("open", () => send({ t: "register", tokenHash, name: "Biny", key: options.registrationKey, proto: 1 }));
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("Unexpected binary relay frame.");
      const frame = envelope.parse(JSON.parse(data.toString()));
      if (frame.t === "registered") { registered = true; clearTimeout(timeout); options.onStatus?.("connected"); return; }
      if (frame.t === "error") return;
      if (!registered) throw new Error("Relay is not registered.");
      const id = frame.id;
      if (!id) return;
      if (frame.t === "hreq") { send({ t: "hres", id, status: 403, headers: {} }); send({ t: "hend", id }); return; }
      if (frame.t === "wopen") {
        if (frame.path !== "/__biny_e2e__" || peers.has(id) || peers.size >= 8) { send({ t: "werr", id, message: "Encrypted remote channel required or connection limit reached" }); return; }
        const peer: Peer = { input: Promise.resolve(), output: Promise.resolve(), queued: 0, outputBytes: 0, timer: setTimeout(() => closePeer(id, peer), 10_000) };
        peers.set(id, peer);
        send({ t: "wopened", id });
        return;
      }
      if (frame.t === "wclose") { drop(id); return; }
      if (frame.t !== "wmsg") return;
      const peer = peers.get(id);
      if (!peer) return;
      if (typeof frame.s !== "string" || ++peer.queued > 16) { closePeer(id, peer); return; }
      const packet = frame.s;
      const work = peer.input.then(async () => {
        if (peers.get(id) !== peer) return;
        if (!peer.cipher) {
          const accepted = await acceptRemoteHandshake(options.code, JSON.parse(packet));
          if (peers.get(id) !== peer) return;
          peer.cipher = accepted.cipher;
          clearTimeout(peer.timer);
          send({ t: "wmsg", id, s: JSON.stringify(accepted.welcome) });
          peer.api = options.createPeer(value => encryptedSend(id, peer, value));
          options.onPeerCount?.([...peers.values()].filter(value => value.api).length);
          return;
        }
        const value = remoteRequestSchema.safeParse(await peer.cipher.decrypt(packet));
        if (peers.get(id) !== peer) return;
        if (!value.success) throw new Error("Invalid remote request.");
        try {
          const result = await peer.api!.handle(value.data);
          encryptedSend(id, peer, { t: "response", id: value.data.id, result });
        } catch (error) {
          encryptedSend(id, peer, { t: "response", id: value.data.id, error: redactSecrets(error instanceof Error ? error.message : "Remote request failed.") });
        }
      }).catch(() => closePeer(id, peer)).finally(() => { peer.queued--; });
      peer.input = work;
      pending.add(work);
      void work.finally(() => pending.delete(work));
    } catch { socket.close(1008, "Invalid relay frame"); }
  });
  try {
    const code = await new Promise<number>(resolve => socket.once("close", (code) => resolve(code)));
    return { code, registered };
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    signal.removeEventListener("abort", stop);
    for (const id of peers.keys()) drop(id);
    socket.terminate();
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(pending), new Promise<never>((_resolve, reject) => {
        drainTimeout = setTimeout(() => reject(new Error("Remote requests did not drain within 10 seconds.")), 10_000);
      })]);
    } finally { if (drainTimeout) clearTimeout(drainTimeout); }
  }
}
