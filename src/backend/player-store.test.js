import { describe, expect, it } from "vitest";
import { toUnixOrNull } from "./player-store.js";

describe("toUnixOrNull", () => {
  it("converts an ISO 8601 string to Unix seconds", () => {
    expect(toUnixOrNull("2021-01-01T00:00:00.000Z")).toBe(1609459200);
  });

  it("returns null for missing values", () => {
    expect(toUnixOrNull(null)).toBe(null);
    expect(toUnixOrNull(undefined)).toBe(null);
    expect(toUnixOrNull("")).toBe(null);
  });

  it("returns null for an unparseable date instead of NaN", () => {
    expect(toUnixOrNull("not-a-date")).toBe(null);
    expect(toUnixOrNull("2021-13-45T99:99:99Z")).toBe(null);
  });

  it("floors sub-second precision to whole seconds", () => {
    expect(toUnixOrNull("2021-01-01T00:00:00.999Z")).toBe(1609459200);
  });
});
