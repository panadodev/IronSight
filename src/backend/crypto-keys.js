// AES-256-GCM encryption for stored secrets (Pterodactyl panel keys and the
// per-org external API keys, which share the same key material). Derives keys
// from env on first use and caches them.

import crypto from "node:crypto";
import { env } from "./config.js";

let pterodactylEncryptionKey;
let pterodactylEncryptionKeyV2;

export function getPterodactylEncryptionKey() {
  if (pterodactylEncryptionKey) return pterodactylEncryptionKey;
  const secret = String(env.pterodactylEncryptionSecret ?? "").trim();
  if (!secret) return null;
  // Legacy SHA-256 key — used only for decrypting v1-prefixed ciphertexts.
  pterodactylEncryptionKey = crypto
    .createHash("sha256")
    .update(secret)
    .digest();
  return pterodactylEncryptionKey;
}

function getPterodactylEncryptionKeyV2() {
  if (pterodactylEncryptionKeyV2) return pterodactylEncryptionKeyV2;
  const secret = String(env.pterodactylEncryptionSecret ?? "").trim();
  if (!secret) return null;
  pterodactylEncryptionKeyV2 = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("ironsight-v2-salt", "utf8"),
      Buffer.from("pterodactyl-encryption", "utf8"),
      32,
    ),
  );
  return pterodactylEncryptionKeyV2;
}

export function encryptPterodactylApiKey(apiKey) {
  const key = getPterodactylEncryptionKeyV2();
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(apiKey), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v2",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
}

export function decryptPterodactylApiKey(payload) {
  const [version, ivB64, ciphertextB64, authTagB64] = String(
    payload ?? "",
  ).split(":");
  if (!ivB64 || !ciphertextB64 || !authTagB64) {
    throw new Error("pterodactyl_encryption_invalid_payload");
  }

  let key;
  if (version === "v1") {
    key = getPterodactylEncryptionKey();
  } else if (version === "v2") {
    key = getPterodactylEncryptionKeyV2();
  } else {
    throw new Error("pterodactyl_encryption_invalid_payload");
  }
  if (!key) throw new Error("pterodactyl_encryption_unconfigured");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptExternalApiKey(apiKey) {
  return encryptPterodactylApiKey(apiKey);
}

export function decryptExternalApiKey(payload) {
  return decryptPterodactylApiKey(payload);
}
