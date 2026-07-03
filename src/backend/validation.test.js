import { describe, expect, it } from "vitest";
import {
  isValidSteamId,
  sanitizeNext,
  sanitizeReportedPlayers,
  sanitizeTicketFields,
} from "./validation.js";

describe("isValidSteamId", () => {
  it("accepts a valid SteamID64", () => {
    expect(isValidSteamId("76561198000000001")).toBe(true);
  });

  it("rejects ids that are too short or too long", () => {
    expect(isValidSteamId("765611980000")).toBe(false);
    expect(isValidSteamId("765611980000000010")).toBe(false);
  });

  it("rejects non-numeric and wrong-prefix ids", () => {
    expect(isValidSteamId("not-a-steam-id")).toBe(false);
    expect(isValidSteamId("12345678901234567")).toBe(false);
  });

  it("coerces non-strings before testing", () => {
    expect(isValidSteamId(76561198000000001n)).toBe(true);
    expect(isValidSteamId(null)).toBe(false);
    expect(isValidSteamId(undefined)).toBe(false);
  });
});

describe("sanitizeNext", () => {
  it("passes through same-site absolute paths", () => {
    expect(sanitizeNext("/players")).toBe("/players");
    expect(sanitizeNext("/orgs/abc/tickets")).toBe("/orgs/abc/tickets");
  });

  it("blocks protocol-relative and absolute URLs (open redirect)", () => {
    expect(sanitizeNext("//evil.com")).toBe("/todo");
    expect(sanitizeNext("https://evil.com")).toBe("/todo");
    expect(sanitizeNext("javascript:alert(1)")).toBe("/todo");
  });

  it("falls back when empty or non-path, honoring a custom fallback", () => {
    expect(sanitizeNext("")).toBe("/todo");
    expect(sanitizeNext(null)).toBe("/todo");
    expect(sanitizeNext("relative/path")).toBe("/todo");
    expect(sanitizeNext("//x", "/home")).toBe("/home");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeNext("  /players  ")).toBe("/players");
  });
});

describe("sanitizeReportedPlayers", () => {
  it("returns [] for non-arrays", () => {
    expect(sanitizeReportedPlayers(undefined)).toEqual([]);
    expect(sanitizeReportedPlayers("76561199000000001")).toEqual([]);
    expect(sanitizeReportedPlayers(null)).toEqual([]);
  });

  it("keeps only valid reported SteamID64s, trimming whitespace", () => {
    const input = [" 76561199000000001 ", "garbage", "76561199000000002"];
    expect(sanitizeReportedPlayers(input)).toEqual([
      "76561199000000001",
      "76561199000000002",
    ]);
  });

  it("caps the result at the max (default 10)", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `765611990000000${String(i).padStart(2, "0")}`,
    );
    expect(sanitizeReportedPlayers(many)).toHaveLength(10);
    expect(sanitizeReportedPlayers(many, { max: 3 })).toHaveLength(3);
  });

  it("bounds scanning work before validating (scanLimit)", () => {
    // A valid id sitting past the scan window is never reached.
    const padded = [
      ...Array.from({ length: 50 }, () => "invalid"),
      "76561199000000001",
    ];
    expect(sanitizeReportedPlayers(padded)).toEqual([]);
  });
});

describe("sanitizeTicketFields", () => {
  it("returns [] when fields are omitted", () => {
    expect(sanitizeTicketFields(undefined)).toEqual([]);
    expect(sanitizeTicketFields(null)).toEqual([]);
  });

  it("rejects malformed payloads with null", () => {
    expect(sanitizeTicketFields("not-an-array")).toBeNull();
    expect(sanitizeTicketFields({ label: "x", value: "y" })).toBeNull();
    expect(sanitizeTicketFields([["label", "value"]])).toBeNull();
    expect(sanitizeTicketFields([null])).toBeNull();
  });

  it("trims labels and values, dropping empty entries", () => {
    expect(
      sanitizeTicketFields([
        { label: "  Server ", value: " EU Main " },
        { label: "Empty", value: "   " },
        { label: "", value: "orphaned" },
      ]),
    ).toEqual([{ label: "Server", value: "EU Main" }]);
  });

  it("coerces non-string label/value to strings", () => {
    expect(sanitizeTicketFields([{ label: "Hours", value: 120 }])).toEqual([
      { label: "Hours", value: "120" },
    ]);
  });

  it("rejects payloads over the caps instead of truncating", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      label: `q${i}`,
      value: "a",
    }));
    expect(sanitizeTicketFields(tooMany)).toBeNull();
    expect(
      sanitizeTicketFields([{ label: "x".repeat(121), value: "a" }]),
    ).toBeNull();
    expect(
      sanitizeTicketFields([{ label: "a", value: "x".repeat(10001) }]),
    ).toBeNull();
  });

  it("honors custom caps", () => {
    expect(
      sanitizeTicketFields([{ label: "ab", value: "cd" }], { maxLabel: 1 }),
    ).toBeNull();
    expect(
      sanitizeTicketFields(
        [
          { label: "a", value: "1" },
          { label: "b", value: "2" },
        ],
        { maxFields: 1 },
      ),
    ).toBeNull();
  });
});
