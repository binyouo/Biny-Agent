import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptRemoteHandshake, beginRemoteHandshake, generateConnectCode, routingToken } from "../src/remote/crypto.js";

test("remote handshake authenticates both ends and separates routing from the connect code", async () => {
  const code = generateConnectCode();
  assert.match(code, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(await routingToken(code), code);
  assert.equal(await routingToken(code), await routingToken(code));
  const phone = await beginRemoteHandshake(code);
  const desktop = await acceptRemoteHandshake(code, phone.hello);
  const client = await phone.finish(desktop.welcome);
  const encrypted = await client.encrypt({ message: "private request" });
  assert.ok(!encrypted.includes("private request"));
  assert.deepEqual(await desktop.cipher.decrypt(encrypted), { message: "private request" });
  assert.deepEqual(await client.decrypt(await desktop.cipher.encrypt({ answer: "private reply" })), { answer: "private reply" });
  await assert.rejects(desktop.cipher.decrypt(encrypted), /sequence/u);
});

test("a relay cannot forge a handshake, alter data, reflect it, or reuse it on another connection", async () => {
  const code = generateConnectCode();
  const phone = await beginRemoteHandshake(code);
  await assert.rejects(acceptRemoteHandshake(generateConnectCode(), phone.hello), /authentication/u);
  const desktop = await acceptRemoteHandshake(code, phone.hello);
  await assert.rejects(phone.finish({ ...desktop.welcome, nonce: "A".repeat(43) }), /authentication/u);
  const client = await phone.finish(desktop.welcome);
  const packet = await client.encrypt({ action: "send" });
  await assert.rejects(client.decrypt(packet));
  const modified = JSON.parse(packet) as { b: string };
  modified.b = (modified.b[0] === "A" ? "B" : "A") + modified.b.slice(1);
  await assert.rejects(desktop.cipher.decrypt(JSON.stringify(modified)));
  assert.deepEqual(await desktop.cipher.decrypt(packet), { action: "send" });
  const other = await acceptRemoteHandshake(code, (await beginRemoteHandshake(code)).hello);
  await assert.rejects(other.cipher.decrypt(packet));
});
