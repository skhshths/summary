// Web Push using only WebCrypto: VAPID sign-in (RFC 8292) and payload
// encryption (RFC 8291), so the push service can't read reminder text.

const encoder = new TextEncoder();

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// Returns { publicKey, privateKey }: the public key in the base64url form
// browsers expect, the private key as a JWK.
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return {
    publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function vapidHeader(endpoint, keys, subject, now = Date.now()) {
  const head = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${head}.${claims}`),
  );
  return `vapid t=${head}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

// p256dh and auth come from the browser's push subscription.
export async function encryptPayload(text, p256dh, auth) {
  const browserKey = fromBase64Url(p256dh);
  const secret = fromBase64Url(auth);
  const curve = { name: "ECDH", namedCurve: "P-256" };

  const ours = await crypto.subtle.generateKey(curve, true, ["deriveBits"]);
  const ourKey = new Uint8Array(await crypto.subtle.exportKey("raw", ours.publicKey));
  const theirs = await crypto.subtle.importKey("raw", browserKey, curve, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, ours.privateKey, 256),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info = concat(encoder.encode("WebPush: info\0"), browserKey, ourKey);
  const ikm = await hkdf(secret, shared, info, 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const padded = concat(encoder.encode(text), new Uint8Array([2])); // 2 marks the last record
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded),
  );

  // header: salt, record size (4096), key length, our public key
  return concat(salt, new Uint8Array([0, 0, 16, 0, ourKey.length]), ourKey, sealed);
}

// Sends one notification; returns the push service's HTTP status.
export async function sendPush(subscription, message, keys, subject) {
  const body = await encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(subscription.endpoint, keys, subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(12 * 60 * 60),
      urgency: "high",
    },
    body,
  });
  return res.status;
}

// The Worker only ever posts to the major browsers' push services.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;

export function isPushEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}
