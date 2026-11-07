const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const context = "biny-remote-v1";
export const remoteMaxMessageBytes = 1024 * 1024;

export function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid remote encoding.");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
}

function codeBytes(code: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(code);
  if (bytes.length !== 32 || encodeBase64(bytes) !== code) throw new Error("Invalid connect code.");
  return bytes;
}

export function generateConnectCode(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function routingToken(code: string): Promise<string> {
  codeBytes(code);
  return encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${context}:routing:${code}`))));
}

interface Handshake {
  t: "hello" | "welcome";
  publicKey: string;
  nonce: string;
  proof: string;
}

function handshake(value: unknown, type: Handshake["t"]): Handshake {
  const frame = value as Partial<Handshake> | null;
  if (!frame || frame.t !== type || typeof frame.publicKey !== "string" || frame.publicKey.length !== 87
    || typeof frame.nonce !== "string" || frame.nonce.length !== 43 || typeof frame.proof !== "string" || frame.proof.length !== 43) {
    throw new Error("Invalid remote handshake.");
  }
  return frame as Handshake;
}

async function authenticate(code: string, text: string, proof?: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", codeBytes(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  if (proof !== undefined && !await crypto.subtle.verify("HMAC", key, decodeBase64(proof), encoder.encode(text))) {
    throw new Error("Remote authentication failed.");
  }
  return encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}

async function ephemeral(): Promise<{ pair: CryptoKeyPair; publicKey: string; nonce: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { pair, publicKey: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), nonce: generateConnectCode() };
}

function transcript(hello: Pick<Handshake, "publicKey" | "nonce">, welcome?: Pick<Handshake, "publicKey" | "nonce">): string {
  return JSON.stringify([context, hello.publicKey, hello.nonce, welcome?.publicKey ?? null, welcome?.nonce ?? null]);
}

export interface RemoteCipher {
  /** 每条通道按发送与接收顺序调用；调用方负责串行发送完整帧。 */
  encrypt(value: unknown): Promise<string>;
  decrypt(packet: string): Promise<unknown>;
}

async function cipher(code: string, pair: CryptoKeyPair, peer: string, text: string, server: boolean): Promise<RemoteCipher> {
  const publicKey = await crypto.subtle.importKey("raw", decodeBase64(peer), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, pair.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = (direction: string) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: codeBytes(code), info: encoder.encode(`${text}:${direction}`) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const clientKey = await key("client");
  const serverKey = await key("server");
  let sent = 0;
  let received = 0;
  const iv = (sequence: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(sequence));
    return bytes;
  };
  return {
    async encrypt(value) {
      const bytes = encoder.encode(JSON.stringify(value));
      if (bytes.length > remoteMaxMessageBytes || !Number.isSafeInteger(sent)) throw new Error("Remote message exceeds limit.");
      const sequence = sent++;
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(sequence) }, server ? serverKey : clientKey, bytes);
      return JSON.stringify({ t: "data", n: sequence, b: encodeBase64(new Uint8Array(encrypted)) });
    },
    async decrypt(packet) {
      if (packet.length > remoteMaxMessageBytes * 1.5) throw new Error("Remote message exceeds limit.");
      const frame = JSON.parse(packet) as { t?: string; n?: number; b?: string };
      if (!frame || frame.t !== "data" || frame.n !== received || !Number.isSafeInteger(frame.n) || typeof frame.b !== "string") throw new Error("Invalid remote message sequence.");
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(received) }, server ? clientKey : serverKey, decodeBase64(frame.b));
      if (bytes.byteLength > remoteMaxMessageBytes) throw new Error("Remote message exceeds limit.");
      received++;
      return JSON.parse(decoder.decode(bytes)) as unknown;
    }
  };
}

export async function beginRemoteHandshake(code: string): Promise<{ hello: Handshake; finish(value: unknown): Promise<RemoteCipher> }> {
  const local = await ephemeral();
  const hello: Handshake = { t: "hello", publicKey: local.publicKey, nonce: local.nonce, proof: await authenticate(code, transcript(local)) };
  return { hello, async finish(value) {
    const welcome = handshake(value, "welcome");
    const text = transcript(hello, welcome);
    await authenticate(code, text, welcome.proof);
    return await cipher(code, local.pair, welcome.publicKey, text, false);
  } };
}

export async function acceptRemoteHandshake(code: string, value: unknown): Promise<{ welcome: Handshake; cipher: RemoteCipher }> {
  const hello = handshake(value, "hello");
  await authenticate(code, transcript(hello), hello.proof);
  const local = await ephemeral();
  const text = transcript(hello, local);
  return { welcome: { t: "welcome", publicKey: local.publicKey, nonce: local.nonce, proof: await authenticate(code, text) },
    cipher: await cipher(code, local.pair, hello.publicKey, text, true) };
}
