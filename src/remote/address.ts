export function remoteRelayUrl(input: string): URL {
  const url = new URL(input);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && local)) {
    throw new Error("Relay must be an HTTPS origin (HTTP is allowed only on loopback).");
  }
  return url;
}

export function remotePairingUrl(relay: string, code: string): string {
  const url = new URL("biny://connect");
  url.search = new URLSearchParams({ v: "1", e2e: "1", u: remoteRelayUrl(relay).origin, k: code }).toString();
  return url.href;
}
