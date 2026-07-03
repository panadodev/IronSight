import { describe, expect, it, vi } from "vitest";

// relay.js pulls in pool/env/crypto-keys at import; the crypto + URL helpers
// under test don't use them, so stub them out for a hermetic test.
vi.mock("./runtime.js", () => ({ pool: null, redis: null }));
vi.mock("./config.js", () => ({ env: { relayAllowInsecure: false } }));
vi.mock("./crypto-keys.js", () => ({ decryptExternalApiKey: (x) => x }));

import {
  decryptFromRelay,
  encryptForRelay,
  generateRelayKey,
  normalizeRelayBaseUrl,
} from "./relay.js";

describe("relay key", () => {
  it("generates a 32-byte base64url key", () => {
    const key = generateRelayKey();
    expect(Buffer.from(key, "base64url").length).toBe(32);
  });
});

describe("relay envelope crypto", () => {
  it("round-trips an object", () => {
    const key = generateRelayKey();
    const payload = {
      method: "GET",
      url: "https://api.battlemetrics.com/x",
      ts: 1,
    };
    const env = encryptForRelay(key, payload);
    expect(env.v).toBe(1);
    expect(decryptFromRelay(key, env)).toEqual(payload);
  });

  it("rejects a tampered ciphertext (GCM auth)", () => {
    const key = generateRelayKey();
    const env = encryptForRelay(key, { a: 1 });
    const badCt = Buffer.from(env.ct, "base64url");
    badCt[0] ^= 0xff;
    const tampered = { ...env, ct: badCt.toString("base64url") };
    expect(() => decryptFromRelay(key, tampered)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const env = encryptForRelay(generateRelayKey(), { a: 1 });
    expect(() => decryptFromRelay(generateRelayKey(), env)).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    const shortKey = Buffer.alloc(16).toString("base64url");
    expect(() => encryptForRelay(shortKey, { a: 1 })).toThrow(
      "relay_key_invalid_length",
    );
  });

  it("rejects a malformed envelope", () => {
    const key = generateRelayKey();
    expect(() => decryptFromRelay(key, { iv: "x" })).toThrow(
      "relay_envelope_invalid",
    );
  });
});

describe("normalizeRelayBaseUrl", () => {
  it("accepts a public https host and strips path/query", () => {
    expect(normalizeRelayBaseUrl("https://relay1.example.com/proxy?x=1")).toBe(
      "https://relay1.example.com",
    );
  });

  it("rejects http in production mode", () => {
    expect(() => normalizeRelayBaseUrl("http://relay1.example.com")).toThrow();
  });

  it("rejects private / loopback hosts", () => {
    expect(() => normalizeRelayBaseUrl("https://127.0.0.1")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://10.0.0.5")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://localhost")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://foo.internal")).toThrow();
  });

  it("rejects a garbage value", () => {
    expect(() => normalizeRelayBaseUrl("not a url")).toThrow();
    expect(() => normalizeRelayBaseUrl("")).toThrow();
  });
});
