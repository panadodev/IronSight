import { vi, describe, expect, it } from "vitest";

vi.mock("./runtime.js", () => ({ pool: null, redis: null }));
vi.mock("./config.js", () => ({ env: {}, SESSION_COOKIE: "panel_session" }));

import {
  redirect,
  canWriteTodos,
  isGlobalAdmin,
  canManageOrg,
  canViewOrgAsOwner,
  orgHasPermission,
  sessionRankForOrg,
} from "./core.js";

// Minimal session factory — only the fields each function inspects.
const session = (overrides = {}) => ({
  globalAdmin: false,
  orgOwnerOrgIds: [],
  orgAdminOrgIds: [],
  orgPermissions: {},
  groups: [],
  canWrite: false,
  ...overrides,
});

describe("redirect", () => {
  it("returns a 302 response with the correct location header", () => {
    const res = redirect("/dashboard");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("preserves extra headers passed in", () => {
    const headers = new Headers({ "set-cookie": "foo=bar" });
    const res = redirect("/login", headers);
    expect(res.headers.get("set-cookie")).toBe("foo=bar");
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("canWriteTodos", () => {
  it("returns true when session.canWrite is set", () => {
    expect(canWriteTodos(session({ canWrite: true }))).toBe(true);
  });

  it("returns true for org owners", () => {
    expect(canWriteTodos(session({ orgOwnerOrgIds: ["org1"] }))).toBe(true);
  });

  it("returns true for org admins", () => {
    expect(canWriteTodos(session({ orgAdminOrgIds: ["org1"] }))).toBe(true);
  });

  it("returns true when a group has admin flag", () => {
    expect(canWriteTodos(session({ groups: [{ admin: true }] }))).toBe(true);
  });

  it("returns true when a group has editUsers flag", () => {
    expect(canWriteTodos(session({ groups: [{ editUsers: true }] }))).toBe(
      true,
    );
  });

  it("returns false with no qualifying fields", () => {
    expect(canWriteTodos(session())).toBe(false);
  });

  it("returns false when groups exist but none have admin/editUsers", () => {
    expect(canWriteTodos(session({ groups: [{ name: "member" }] }))).toBe(
      false,
    );
  });

  it("returns false for null/undefined session", () => {
    expect(canWriteTodos(null)).toBe(false);
    expect(canWriteTodos(undefined)).toBe(false);
  });
});

describe("isGlobalAdmin", () => {
  it("returns true when session.globalAdmin is set", () => {
    expect(isGlobalAdmin(session({ globalAdmin: true }))).toBe(true);
  });

  it("returns true when a group has admin: true", () => {
    expect(isGlobalAdmin(session({ groups: [{ admin: true }] }))).toBe(true);
  });

  it("returns false with no qualifying fields", () => {
    expect(isGlobalAdmin(session())).toBe(false);
  });

  it("returns false for null session", () => {
    expect(isGlobalAdmin(null)).toBe(false);
  });
});

describe("canManageOrg", () => {
  it("returns true when orgId is in orgAdminOrgIds", () => {
    expect(canManageOrg(session({ orgAdminOrgIds: ["org1"] }), "org1")).toBe(
      true,
    );
  });

  it("returns false when orgId is absent", () => {
    expect(canManageOrg(session({ orgAdminOrgIds: ["org1"] }), "org2")).toBe(
      false,
    );
  });

  it("returns false with an empty admin list", () => {
    expect(canManageOrg(session(), "org1")).toBe(false);
  });
});

describe("canViewOrgAsOwner", () => {
  it("returns true when the orgId is in orgOwnerOrgIds", () => {
    const s = session({ orgOwnerOrgIds: ["org1"] });
    expect(canViewOrgAsOwner(s, "org1")).toBe(true);
    expect(canViewOrgAsOwner(s, "org2")).toBe(false);
  });

  it("returns false for admins who are not owners", () => {
    const s = session({ orgAdminOrgIds: ["org1"] });
    expect(canViewOrgAsOwner(s, "org1")).toBe(false);
  });

  it("returns true for global admins regardless of orgOwnerOrgIds", () => {
    const s = session({ globalAdmin: true });
    expect(canViewOrgAsOwner(s, "org1")).toBe(true);
  });
});

describe("orgHasPermission", () => {
  it("returns true when the user can manage the org", () => {
    const s = session({ orgAdminOrgIds: ["org1"] });
    expect(orgHasPermission(s, "org1", "some_perm")).toBe(true);
  });

  it("returns true when the permission is in the org permissions list", () => {
    const s = session({ orgPermissions: { org1: ["view_players", "ban"] } });
    expect(orgHasPermission(s, "org1", "ban")).toBe(true);
  });

  it("returns false when neither condition is met", () => {
    const s = session({ orgPermissions: { org1: ["view_players"] } });
    expect(orgHasPermission(s, "org1", "ban")).toBe(false);
  });

  it("returns false for an org with no permission entry", () => {
    expect(orgHasPermission(session(), "org1", "ban")).toBe(false);
  });
});

describe("sessionRankForOrg", () => {
  it("returns 4 for a global admin", () => {
    expect(sessionRankForOrg(session({ globalAdmin: true }), "org1")).toBe(4);
  });

  it("returns 4 for an org owner", () => {
    const s = session({ orgOwnerOrgIds: ["org1"] });
    expect(sessionRankForOrg(s, "org1")).toBe(4);
  });

  it("returns 4 for an org admin", () => {
    const s = session({ orgAdminOrgIds: ["org1"] });
    expect(sessionRankForOrg(s, "org1")).toBe(4);
  });

  it("returns 3 when the user has at least one org permission", () => {
    const s = session({ orgPermissions: { org1: ["view_players"] } });
    expect(sessionRankForOrg(s, "org1")).toBe(3);
  });

  it("returns 1 for an unprivileged user", () => {
    expect(sessionRankForOrg(session(), "org1")).toBe(1);
  });

  it("returns 1 when the user has permissions for a different org", () => {
    const s = session({ orgPermissions: { org2: ["ban"] } });
    expect(sessionRankForOrg(s, "org1")).toBe(1);
  });
});
