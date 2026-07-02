import { beforeAll, describe, expect, it } from "vitest";

// config.js reads process.env at import time, so the secret must be set
// before r2.js (which imports config) is loaded — hence the dynamic import.
let signedMediaPath;
let verifyMediaSignature;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const r2 = await import("./r2.js");
  signedMediaPath = r2.signedMediaPath;
  verifyMediaSignature = r2.verifyMediaSignature;
});

function parseSignedPath(path) {
  const url = new URL(path, "http://localhost");
  return {
    exp: url.searchParams.get("e"),
    sig: url.searchParams.get("s"),
    pathname: url.pathname,
  };
}

describe("signedMediaPath / verifyMediaSignature", () => {
  const mediaId = "0b0e8a1c-9f43-4f5f-8b7e-2f2b6a1d9c11";

  it("mints a path that verifies", () => {
    const path = signedMediaPath(mediaId);
    const { exp, sig, pathname } = parseSignedPath(path);
    expect(pathname).toBe(`/api/media/${mediaId}/file`);
    expect(verifyMediaSignature(mediaId, exp, sig)).toBe(true);
  });

  it("expiry is at least one full window in the future", () => {
    const { exp } = parseSignedPath(signedMediaPath(mediaId));
    expect(Number(exp)).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 6 * 3600,
    );
  });

  it("is stable within a signature window (cache-friendly)", () => {
    expect(signedMediaPath(mediaId)).toBe(signedMediaPath(mediaId));
  });

  it("rejects a signature minted for another mediaId", () => {
    const { exp, sig } = parseSignedPath(signedMediaPath(mediaId));
    expect(
      verifyMediaSignature("11111111-2222-3333-4444-555555555555", exp, sig),
    ).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    const { exp, sig } = parseSignedPath(signedMediaPath(mediaId));
    expect(verifyMediaSignature(mediaId, Number(exp) + 3600, sig)).toBe(false);
  });

  it("rejects an expired timestamp even with a matching signature shape", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(verifyMediaSignature(mediaId, past, "whatever")).toBe(false);
  });

  it("rejects garbage inputs without throwing", () => {
    expect(verifyMediaSignature(mediaId, "not-a-number", "sig")).toBe(false);
    expect(verifyMediaSignature(mediaId, null, null)).toBe(false);
    expect(verifyMediaSignature(mediaId, "", "")).toBe(false);
  });
});
