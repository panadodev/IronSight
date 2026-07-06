import { describe, expect, it } from "vitest";
import {
  json,
  parseLimit,
  parseMaybeList,
  getClientIp,
  ipPinScope,
} from "./http.js";

describe("json", () => {
  it("defaults to status 200 with JSON content-type", async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await res.json()).toEqual({ ok: true });
  });

  it("forwards an explicit status code", async () => {
    const res = json({ error: "Not found" }, 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("serializes nested objects and arrays", async () => {
    const data = { items: [1, 2, 3], nested: { a: true } };
    expect(await json(data).json()).toEqual(data);
  });
});

describe("parseLimit", () => {
  it("returns the value when within bounds", () => {
    expect(parseLimit("50", 200, 500)).toBe(50);
  });

  it("returns fallback for NaN input", () => {
    expect(parseLimit("abc", 200, 500)).toBe(200);
    expect(parseLimit(undefined, 200, 500)).toBe(200);
    expect(parseLimit(null, 200, 500)).toBe(200);
  });

  it("returns fallback for zero and negative values", () => {
    expect(parseLimit("0", 200, 500)).toBe(200);
    expect(parseLimit("-10", 200, 500)).toBe(200);
  });

  it("clamps to max when the input exceeds it", () => {
    expect(parseLimit("1000", 200, 500)).toBe(500);
    expect(parseLimit("500", 200, 500)).toBe(500);
  });

  it("floors fractional values", () => {
    expect(parseLimit("7.9", 200, 500)).toBe(7);
  });
});

describe("parseMaybeList", () => {
  it("returns [] for falsy inputs", () => {
    expect(parseMaybeList(null)).toEqual([]);
    expect(parseMaybeList(undefined)).toEqual([]);
    expect(parseMaybeList("")).toEqual([]);
    expect(parseMaybeList(0)).toEqual([]);
  });

  it("returns a filtered string array when given an array", () => {
    expect(parseMaybeList(["a", "", "b", null])).toEqual(["a", "b"]);
    expect(parseMaybeList([1, 2])).toEqual(["1", "2"]);
  });

  it("parses a JSON-encoded array string", () => {
    expect(parseMaybeList('["a","b","c"]')).toEqual(["a", "b", "c"]);
    expect(parseMaybeList('["x",null,"y"]')).toEqual(["x", "y"]);
  });

  it("falls back to CSV when JSON parse fails", () => {
    expect(parseMaybeList("[not json]")).toEqual(["[not json]"]);
  });

  it("splits a plain CSV string", () => {
    expect(parseMaybeList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseMaybeList("a , b , c")).toEqual(["a", "b", "c"]);
  });

  it("filters empty segments from CSV", () => {
    expect(parseMaybeList("a,,b")).toEqual(["a", "b"]);
  });

  it("wraps a single non-array string in an array", () => {
    expect(parseMaybeList("hello")).toEqual(["hello"]);
  });
});

describe("getClientIp", () => {
  const makeRequest = (headers) =>
    new Request("https://example.com", { headers });

  it("prefers cf-connecting-ip", () => {
    const req = makeRequest({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to the right-most x-forwarded-for hop", () => {
    const req = makeRequest({
      "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3",
    });
    expect(getClientIp(req)).toBe("10.0.0.3");
  });

  it("handles a single x-forwarded-for hop", () => {
    const req = makeRequest({ "x-forwarded-for": "203.0.113.5" });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("trims whitespace from cf-connecting-ip", () => {
    const req = makeRequest({ "cf-connecting-ip": "  1.2.3.4  " });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("returns 'unknown' when no IP headers are present", () => {
    const req = makeRequest({});
    expect(getClientIp(req)).toBe("unknown");
  });
});

describe("ipPinScope", () => {
  it("returns null for unknown/empty/non-string inputs", () => {
    expect(ipPinScope("unknown")).toBe(null);
    expect(ipPinScope("")).toBe(null);
    expect(ipPinScope(null)).toBe(null);
    expect(ipPinScope(undefined)).toBe(null);
    expect(ipPinScope(42)).toBe(null);
  });

  it("pins IPv4 on the exact address", () => {
    expect(ipPinScope("203.0.113.9")).toBe("203.0.113.9");
    expect(ipPinScope("  203.0.113.9  ")).toBe("203.0.113.9");
  });

  it("pins IPv6 on the /64 prefix", () => {
    expect(ipPinScope("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(
      "2001:0db8:85a3:08d3::/64",
    );
  });

  it("matches two IPv6 addresses in the same /64 (privacy extensions)", () => {
    const a = ipPinScope("2001:db8:85a3:8d3:1319:8a2e:370:7348");
    const b = ipPinScope("2001:db8:85a3:8d3:ffff:eeee:dddd:cccc");
    expect(a).toBe(b);
  });

  it("distinguishes IPv6 addresses in different /64s", () => {
    const a = ipPinScope("2001:db8:85a3:8d3::1");
    const b = ipPinScope("2001:db8:85a3:8d4::1");
    expect(a).not.toBe(b);
  });

  it("expands :: shorthand", () => {
    expect(ipPinScope("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(ipPinScope("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("is case-insensitive for IPv6", () => {
    expect(ipPinScope("2001:DB8:85A3:8D3::1")).toBe(
      ipPinScope("2001:db8:85a3:8d3::1"),
    );
  });

  it("maps IPv4-mapped IPv6 onto the IPv4 scope", () => {
    expect(ipPinScope("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipPinScope("::ffff:203.0.113.9")).toBe(ipPinScope("203.0.113.9"));
  });

  it("strips zone indexes and brackets", () => {
    expect(ipPinScope("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(ipPinScope("[2001:db8::1]")).toBe("2001:0db8:0000:0000::/64");
  });

  it("returns null for malformed IPv6", () => {
    expect(ipPinScope("2001:db8:::1")).toBe(null);
    expect(ipPinScope("1:2:3:4:5:6:7:8:9")).toBe(null);
    expect(ipPinScope("gggg::1")).toBe(null);
  });
});
