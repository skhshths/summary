import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  hkdf,
  isPushEndpoint,
  toBase64Url,
  vapidHeader,
} from "./push.js";

const encoder = new TextEncoder();

// Decrypts the way a browser does (RFC 8291), acting as the receiver.
async function decrypt(body, browser, secret) {
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const salt = body.slice(0, 16);
  const keyLength = body[20];
  const senderKey = body.slice(21, 21 + keyLength);
  const sealed = body.slice(21 + keyLength);

  const browserKey = new Uint8Array(await crypto.subtle.exportKey("raw", browser.publicKey));
  const sender = await crypto.subtle.importKey("raw", senderKey, curve, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, browser.privateKey, 256),
  );
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...browserKey, ...senderKey]);
  const ikm = await hkdf(secret, shared, info, 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
}

test("a browser's keys can decrypt the payload", async () => {
  const browser = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = toBase64Url(await crypto.subtle.exportKey("raw", browser.publicKey));
  const secret = crypto.getRandomValues(new Uint8Array(16));

  const text = JSON.stringify({ title: "Pack cleats ⚽" });
  const body = await encryptPayload(text, p256dh, toBase64Url(secret));

  assert.deepEqual([...body.slice(16, 20)], [0, 0, 16, 0], "record size 4096");
  assert.equal(body[20], 65, "uncompressed P-256 key");

  const plain = await decrypt(body, browser, secret);
  assert.equal(plain.at(-1), 2, "last-record delimiter");
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), text);
});

test("the VAPID token verifies against the public key", async () => {
  const keys = await generateVapidKeys();
  const now = Date.UTC(2026, 10, 4);
  const header = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", keys, "https://daily.oliverbar.net", now);

  const [, token, publicKey] = header.match(/^vapid t=(.+), k=(.+)$/);
  assert.equal(publicKey, keys.publicKey);

  const [head, claims, signature] = token.split(".");
  const verifier = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifier,
    fromBase64Url(signature),
    encoder.encode(`${head}.${claims}`),
  );
  assert.equal(valid, true);

  const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
  assert.equal(decoded.aud, "https://fcm.googleapis.com");
  assert.equal(decoded.sub, "https://daily.oliverbar.net");
  assert.equal(decoded.exp, now / 1000 + 12 * 60 * 60);
});

test("only known push services are accepted", () => {
  assert.equal(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"), true);
  assert.equal(isPushEndpoint("https://web.push.apple.com/abc"), true);
  assert.equal(isPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=abc"), true);
  assert.equal(isPushEndpoint("http://fcm.googleapis.com/x"), false);
  assert.equal(isPushEndpoint("https://evilfcm.googleapis.com.example.com/x"), false);
  assert.equal(isPushEndpoint("https://example.com/x"), false);
  assert.equal(isPushEndpoint("not a url"), false);
});
