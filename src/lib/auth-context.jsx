import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { manageOrgStore } from "./manage-org-store";
import { TEAM_META } from "./constants";
const BAN_CATEGORIES = ["cheating", "teaming", "toxicity"];
const BAN_CATEGORY_LABEL = {
  cheating: "Cheating",
  teaming: "Teaming",
  toxicity: "Toxicity",
};
const TICKET_TYPE_KEYS = [
  "cheating",
  "teaming",
  "toxicity",
  "support",
  "vip",
  "appeal",
];
const TICKET_TYPE_LABELS = {
  cheating: "Cheating",
  teaming: "Teaming",
  toxicity: "Toxicity",
  support: "Support",
  vip: "VIP",
  appeal: "Appeal",
};
const AuthContext = createContext(null);
function AuthProvider({ children }) {
  const [view, setView] = useState("staff");
  const [orgs, setOrgs] = useState([]);
  const [staff, setStaff] = useState([]);
  const REAL_STAFF_ID = "u_self";
  const [realStaffId] = useState(REAL_STAFF_ID);
  const [activeStaffId, setActiveStaffId] = useState(REAL_STAFF_ID);
  const [selectedOrgIds, setSelectedOrgIds] = useState([]);
  const [publicSignedIn, setPublicSignedIn] = useState(false);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [sessionOrgAdminIds, setSessionOrgAdminIds] = useState([]);
  const [sessionOrgOwnerIds, setSessionOrgOwnerIds] = useState([]);
  const [sessionOrgPermissions, setSessionOrgPermissions] = useState({});
  const [sessionUser, setSessionUser] = useState(null);
  // Set by impersonate() to the target member's access; null when not active.
  const [viewingAs, setViewingAs] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentOrgs() {
      try {
        const res = await fetch("/api/todo/bootstrap", {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setOrgsLoaded(true);
          return;
        }

        const body = await res.json();
        if (cancelled) return;

        const adminIds = Array.isArray(body?.user?.orgAdminOrgIds)
          ? body.user.orgAdminOrgIds.map(String)
          : [];
        if (!cancelled) setSessionOrgAdminIds(adminIds);

        const ownerIds = Array.isArray(body?.user?.orgOwnerOrgIds)
          ? body.user.orgOwnerOrgIds.map(String)
          : [];
        if (!cancelled) setSessionOrgOwnerIds(ownerIds);

        const orgPerms =
          body?.user?.orgPermissions != null &&
          typeof body.user.orgPermissions === "object"
            ? body.user.orgPermissions
            : {};
        if (!cancelled) setSessionOrgPermissions(orgPerms);

        if (body?.user && !cancelled) {
          const userId = String(body.user.userId ?? "");
          setSessionUser({
            userId,
            username: String(body.user.username ?? ""),
            discordId: body.user.discordId ? String(body.user.discordId) : null,
            steamId: body.user.steamId ? String(body.user.steamId) : null,
            isSysAdmin: body.user.isSysAdmin === true,
            globalAdmin: body.user.globalAdmin === true,
          });
          if (userId) manageOrgStore.init(userId);
          if (body.user.steamId) setPublicSignedIn(true);
        }

        const nextOrgs = (body?.orgs ?? []).map((org) => {
          const name = org?.name ? String(org.name) : String(org?.orgId ?? "");
          const short =
            name
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => part[0])
              .join("")
              .slice(0, 3)
              .toUpperCase() ||
            String(org?.orgId ?? "")
              .slice(0, 3)
              .toUpperCase();
          return {
            id: String(org.orgId),
            name,
            short,
          };
        });

        if (nextOrgs.length > 0) {
          setOrgs(nextOrgs);
          setSelectedOrgIds((current) => {
            const nextIds = new Set(nextOrgs.map((o) => o.id));
            const filtered = current.filter((id) => nextIds.has(id));
            return filtered.length > 0 ? filtered : nextOrgs.map((o) => o.id);
          });
        }
        setOrgsLoaded(true);
      } catch {
        if (!cancelled) setOrgsLoaded(true);
      }
    }

    loadCurrentOrgs();

    return () => {
      cancelled = true;
    };
  }, []);
  const [profile, setProfile] = useState({
    displayName: "",
    steamLinked: null,
    discordLinked: null,
    battlemetricsToken: "",
  });
  const [orgMembers, setOrgMembers] = useState({});
  const [orgToxicity, setOrgToxicity] = useState({});
  const setOrgToxicityPhrases = (orgId, kind, phrases) => {
    if (!isSrOrMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const cleaned = phrases.map((p) => p.trim()).filter((p) => p.length > 0);
    setOrgToxicity((all) => ({
      ...all,
      [orgId]: { ...(all[orgId] ?? { yellow: [], red: [] }), [kind]: cleaned },
    }));
    return { ok: true };
  };
  const [orgPredefines, setOrgPredefines] = useState({});
  const addOrgPredefine = (orgId, input) => {
    if (!isSrOrMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const keyword = input.keyword.trim();
    const content = input.content.trim();
    if (!keyword) return { ok: false, error: "Keyword is required." };
    if (!content) return { ok: false, error: "Content is required." };
    const extras = input.extraKeywords
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const pd = {
      id: `pd_${Math.random().toString(36).slice(2, 9)}`,
      keyword,
      extraKeywords: extras,
      content,
    };
    setOrgPredefines((all) => ({
      ...all,
      [orgId]: [...(all[orgId] ?? []), pd],
    }));
    return { ok: true };
  };
  const updateOrgPredefine = (orgId, id, patch) => {
    if (!isSrOrMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const cleanPatch = { ...patch };
    if (cleanPatch.keyword !== void 0) {
      const k = cleanPatch.keyword.trim();
      if (!k) return { ok: false, error: "Keyword is required." };
      cleanPatch.keyword = k;
    }
    if (cleanPatch.content !== void 0) {
      const c = cleanPatch.content.trim();
      if (!c) return { ok: false, error: "Content is required." };
      cleanPatch.content = c;
    }
    if (cleanPatch.extraKeywords !== void 0) {
      cleanPatch.extraKeywords = cleanPatch.extraKeywords
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    }
    setOrgPredefines((all) => ({
      ...all,
      [orgId]: (all[orgId] ?? []).map((p) =>
        p.id === id ? { ...p, ...cleanPatch } : p,
      ),
    }));
    return { ok: true };
  };
  const removeOrgPredefine = (orgId, id) => {
    if (!isSrOrMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgPredefines((all) => ({
      ...all,
      [orgId]: (all[orgId] ?? []).filter((p) => p.id !== id),
    }));
    return { ok: true };
  };
  const DEFAULT_NOTE_FORMATS = {
    cheating:
      "Ban issued for cheating.\n\nEvidence: \nDemo/clip link: \nDate of offense: \nReviewed by: ",
    teaming:
      "Ban issued for teaming.\n\nGroup size limit: \nPlayers involved: \nEvidence: \nReviewed by: ",
    toxicity:
      "Ban issued for toxicity.\n\nChat log excerpt:\n\nContext: \nPrevious warnings: \nReviewed by: ",
  };
  const DEFAULT_REASONS = {
    cheating: [
      "Aimbot",
      "ESP / Wallhack",
      "Scripts / Macros",
      "Closet cheating",
    ],
    teaming: [
      "Group size violation",
      "Cross-team coordination",
      "Trade-killing",
    ],
    toxicity: ["Slurs / Hate speech", "Harassment", "Threats / Doxxing"],
  };
  const [orgBanConfigs, setOrgBanConfigs] = useState({});
  const ensureBanConfig = (all, orgId) => {
    if (all[orgId]) return all[orgId];
    const perCat = {};
    for (const cat of BAN_CATEGORIES) {
      perCat[cat] = { reasons: [], noteFormat: DEFAULT_NOTE_FORMATS[cat] };
    }
    return perCat;
  };
  const addBanReason = (orgId, category, label) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const trimmed = label.trim();
    if (!trimmed) return { ok: false, error: "Reason cannot be empty." };
    setOrgBanConfigs((all) => {
      const org = ensureBanConfig(all, orgId);
      const reason = {
        id: `br_${Math.random().toString(36).slice(2, 9)}`,
        label: trimmed,
      };
      return {
        ...all,
        [orgId]: {
          ...org,
          [category]: {
            ...org[category],
            reasons: [...org[category].reasons, reason],
          },
        },
      };
    });
    return { ok: true };
  };
  const removeBanReason = (orgId, category, reasonId) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgBanConfigs((all) => {
      const org = ensureBanConfig(all, orgId);
      return {
        ...all,
        [orgId]: {
          ...org,
          [category]: {
            ...org[category],
            reasons: org[category].reasons.filter((r) => r.id !== reasonId),
          },
        },
      };
    });
    return { ok: true };
  };
  const updateBanReason = (orgId, category, reasonId, label) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const trimmed = label.trim();
    if (!trimmed) return { ok: false, error: "Reason cannot be empty." };
    setOrgBanConfigs((all) => {
      const org = ensureBanConfig(all, orgId);
      return {
        ...all,
        [orgId]: {
          ...org,
          [category]: {
            ...org[category],
            reasons: org[category].reasons.map((r) =>
              r.id === reasonId ? { ...r, label: trimmed } : r,
            ),
          },
        },
      };
    });
    return { ok: true };
  };
  const setBanNoteFormat = (orgId, category, format) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgBanConfigs((all) => {
      const org = ensureBanConfig(all, orgId);
      return {
        ...all,
        [orgId]: {
          ...org,
          [category]: { ...org[category], noteFormat: format },
        },
      };
    });
    return { ok: true };
  };
  const DEFAULT_MUTE_NOTE =
    "Mute issued for toxicity.\n\nChat log excerpt:\n\nContext: \nPrevious warnings: \nReviewed by: ";
  const DEFAULT_MUTE_REASONS = [
    "Slurs / Hate speech",
    "Spam",
    "Harassment",
    "Mic abuse",
  ];
  const [orgMuteConfigs, setOrgMuteConfigs] = useState({});
  const ensureMuteConfig = (all, orgId) =>
    all[orgId] ?? { reasons: [], noteFormat: DEFAULT_MUTE_NOTE };
  const addMuteReason = (orgId, label) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const trimmed = label.trim();
    if (!trimmed) return { ok: false, error: "Reason cannot be empty." };
    setOrgMuteConfigs((all) => {
      const cfg = ensureMuteConfig(all, orgId);
      const reason = {
        id: `mr_${Math.random().toString(36).slice(2, 9)}`,
        label: trimmed,
      };
      return { ...all, [orgId]: { ...cfg, reasons: [...cfg.reasons, reason] } };
    });
    return { ok: true };
  };
  const removeMuteReason = (orgId, reasonId) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgMuteConfigs((all) => {
      const cfg = ensureMuteConfig(all, orgId);
      return {
        ...all,
        [orgId]: {
          ...cfg,
          reasons: cfg.reasons.filter((r) => r.id !== reasonId),
        },
      };
    });
    return { ok: true };
  };
  const updateMuteReason = (orgId, reasonId, label) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    const trimmed = label.trim();
    if (!trimmed) return { ok: false, error: "Reason cannot be empty." };
    setOrgMuteConfigs((all) => {
      const cfg = ensureMuteConfig(all, orgId);
      return {
        ...all,
        [orgId]: {
          ...cfg,
          reasons: cfg.reasons.map((r) =>
            r.id === reasonId ? { ...r, label: trimmed } : r,
          ),
        },
      };
    });
    return { ok: true };
  };
  const setMuteNoteFormat = (orgId, format) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgMuteConfigs((all) => {
      const cfg = ensureMuteConfig(all, orgId);
      return { ...all, [orgId]: { ...cfg, noteFormat: format } };
    });
    return { ok: true };
  };
  const loadOrgBanConfigs = useCallback(async (orgId) => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ban-configs`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const body = await res.json();
      setOrgBanConfigs((prev) => ({ ...prev, [orgId]: body.configs ?? {} }));
      setOrgMuteConfigs((prev) => ({
        ...prev,
        [orgId]: body.mute ?? { reasons: [], noteFormat: "" },
      }));
    } catch {}
  }, []);
  const [orgTicketTypes, setOrgTicketTypes] = useState({});
  const setOrgTicketTypeEnabled = (orgId, key, enabled) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgTicketTypes((all) => {
      const cur =
        all[orgId] ??
        TICKET_TYPE_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});
      return { ...all, [orgId]: { ...cur, [key]: enabled } };
    });
    return { ok: true };
  };
  const toggleOrg = (id) =>
    setSelectedOrgIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const updateProfile = (patch) => setProfile((p) => ({ ...p, ...patch }));
  const setStaffTeam = (staffId, team) =>
    setStaff((all) => all.map((s) => (s.id === staffId ? { ...s, team } : s)));
  const activeStaff = useMemo(
    () => staff.find((s) => s.id === activeStaffId) ?? null,
    [staff, activeStaffId],
  );
  const activeRank = activeStaff ? TEAM_META[activeStaff.team].rank : 0;
  // The legacy `orgMembers`/team taxonomy is never populated from the API, so
  // rank and org-access are derived from authoritative session role data.
  // owner/admin map to the management tier (full access); members holding any
  // org permission get a working staff rank; plain members of an org they
  // belong to get the support baseline. Server-side checks remain the real gate.
  // ── View-only impersonation ────────────────────────────────────────────────
  // When an org manager is "viewing as" another member, the UI permission
  // surface is derived from that member's access (scoped to the impersonated
  // org) instead of the real session. The server still authorizes every request
  // by the real session, so this only changes what the UI reveals — it can
  // never escalate privilege. The `real*` helpers below always reflect the true
  // session (used to gate the impersonation entry point itself).
  const isImpersonating = viewingAs != null;
  const impersonatedOrgId = viewingAs?.orgId ?? null;
  const effectiveOrgOwnerIds = isImpersonating
    ? (viewingAs.access?.orgOwnerOrgIds ?? [])
    : sessionOrgOwnerIds;
  const effectiveOrgAdminIds = isImpersonating
    ? (viewingAs.access?.orgAdminOrgIds ?? [])
    : sessionOrgAdminIds;
  const effectiveOrgPermissions =
    isImpersonating && impersonatedOrgId
      ? { [impersonatedOrgId]: viewingAs.access?.permissions ?? [] }
      : sessionOrgPermissions;

  const computeRank = (orgId, ownerIds, adminIds, perms) => {
    if (ownerIds.includes(orgId)) return 4;
    if (adminIds.includes(orgId)) return 4;
    if ((perms[orgId] ?? []).length > 0) return 3;
    if (orgs.some((o) => o.id === orgId)) return 1;
    return 0;
  };
  const rankFromSession = (orgId) =>
    computeRank(
      orgId,
      effectiveOrgOwnerIds,
      effectiveOrgAdminIds,
      effectiveOrgPermissions,
    );
  const realRankFromSession = (orgId) =>
    computeRank(
      orgId,
      sessionOrgOwnerIds,
      sessionOrgAdminIds,
      sessionOrgPermissions,
    );
  const rankOf = rankFromSession;
  const maxRankAcross = (orgIds) => {
    let max = 0;
    for (const id of orgIds) {
      const r = rankFromSession(id);
      if (r > max) max = r;
    }
    return max;
  };
  const isOwner =
    sessionUser != null && effectiveOrgOwnerIds.length > 0
      ? effectiveOrgOwnerIds.some((id) => orgs.some((o) => o.id === id))
      : false;
  // The bootstrap only returns orgs the user is a member of, so every loaded
  // org is one of "my" orgs.
  const myOrgIds = useMemo(() => orgs.map((o) => o.id), [orgs]);
  const manageableOrgIds = useMemo(
    () =>
      Array.from(new Set([...effectiveOrgOwnerIds, ...effectiveOrgAdminIds])),
    [effectiveOrgOwnerIds, effectiveOrgAdminIds],
  );
  const realStaff = useMemo(
    () => staff.find((s) => s.id === realStaffId) ?? null,
    [staff, realStaffId],
  );
  const realIsOwner = sessionOrgOwnerIds.length > 0;
  const realManageableOrgIds = useMemo(
    () => Array.from(new Set([...sessionOrgOwnerIds, ...sessionOrgAdminIds])),
    [sessionOrgOwnerIds, sessionOrgAdminIds],
  );
  const realRankOf = (orgId) => (realIsOwner ? 4 : realRankFromSession(orgId));
  const realAdminableOrgIds = useMemo(
    () => Array.from(new Set([...sessionOrgOwnerIds, ...sessionOrgAdminIds])),
    [sessionOrgOwnerIds, sessionOrgAdminIds],
  );

  const adminableOrgIds = useMemo(
    () =>
      Array.from(new Set([...effectiveOrgOwnerIds, ...effectiveOrgAdminIds])),
    [effectiveOrgOwnerIds, effectiveOrgAdminIds],
  );
  const isMgmtOf = (orgId) => isOwner || manageableOrgIds.includes(orgId);
  const isSrOrMgmtOf = (orgId) => isOwner || adminableOrgIds.includes(orgId);
  const hasOrgPermission = (orgId, permissionId) =>
    effectiveOrgOwnerIds.includes(orgId) ||
    effectiveOrgAdminIds.includes(orgId) ||
    (effectiveOrgPermissions[orgId] ?? []).includes(permissionId);

  const impersonate = async (orgId, memberId) => {
    try {
      const res = await fetch(
        `/api/orgs/${orgId}/members/${memberId}/impersonate`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) {
        console.error("Failed to impersonate member:", res.statusText);
        return { ok: false, error: "Failed to load member data" };
      }
      const data = await res.json();
      if (data.ok) {
        setViewingAs({ ...data, orgId });
        return { ok: true };
      }
      return data;
    } catch (err) {
      console.error("Impersonate error:", err);
      return { ok: false, error: String(err.message) };
    }
  };

  const stopImpersonating = () => setViewingAs(null);
  const addOrgMember = (orgId, input) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    if (!input.steamId && !input.discordId)
      return { ok: false, error: "Steam or Discord ID required" };
    let target = staff.find(
      (s) =>
        (input.steamId && s.steamId === input.steamId) ||
        (input.discordId && s.discordId === input.discordId),
    );
    if (!target) {
      const id = `u_${Math.random().toString(36).slice(2, 8)}`;
      const newStaff = {
        id,
        name:
          input.name ||
          (input.steamId
            ? `steam:${input.steamId.slice(-4)}`
            : `discord:${input.discordId}`),
        role: TEAM_META[input.team].label,
        avatar: (input.name || "??").slice(0, 1).toUpperCase(),
        team: input.team,
        steamId: input.steamId,
        discordId: input.discordId,
      };
      setStaff((all) => [...all, newStaff]);
      target = newStaff;
    }
    const targetId = target.id;
    setOrgMembers((all) => {
      const existing = all[orgId] ?? [];
      if (existing.some((m) => m.staffId === targetId)) return all;
      return {
        ...all,
        [orgId]: [...existing, { staffId: targetId, team: input.team }],
      };
    });
    return { ok: true };
  };
  const removeOrgMember = (orgId, staffId) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgMembers((all) => ({
      ...all,
      [orgId]: (all[orgId] ?? []).filter((m) => m.staffId !== staffId),
    }));
    return { ok: true };
  };
  const setOrgMemberTeam = (orgId, staffId, team) => {
    if (!isMgmtOf(orgId)) return { ok: false, error: "Not authorized" };
    setOrgMembers((all) => ({
      ...all,
      [orgId]: (all[orgId] ?? []).map((m) =>
        m.staffId === staffId ? { ...m, team } : m,
      ),
    }));
    return { ok: true };
  };
  const hasStaffAccount = myOrgIds.length > 0;
  // Memoize the context object so that consumers whose selected slice of state
  // hasn't changed don't re-render every time any piece of AuthProvider state
  // changes (e.g. profile edit shouldn't re-render ban-config consumers).
  const contextValue = useMemo(
    () => ({
      view,
      setView,
      orgs,
      selectedOrgIds,
      toggleOrg,
      setSelectedOrgIds,
      orgMembers,
      manageableOrgIds,
      realManageableOrgIds,
      realAdminableOrgIds,
      adminableOrgIds,
      realRankOf,
      myOrgIds,
      isOwner,
      addOrgMember,
      removeOrgMember,
      setOrgMemberTeam,
      orgToxicity,
      setOrgToxicityPhrases,
      orgPredefines,
      addOrgPredefine,
      updateOrgPredefine,
      removeOrgPredefine,
      orgBanConfigs,
      addBanReason,
      removeBanReason,
      updateBanReason,
      setBanNoteFormat,
      orgMuteConfigs,
      addMuteReason,
      removeMuteReason,
      updateMuteReason,
      setMuteNoteFormat,
      loadOrgBanConfigs,
      orgTicketTypes,
      setOrgTicketTypeEnabled,
      hasStaffAccount,
      publicSignedIn,
      setPublicSignedIn,
      orgsLoaded,
      profile,
      updateProfile,
      staff,
      setStaffTeam,
      realStaffId,
      activeStaffId,
      setActiveStaffId,
      viewingAs,
      impersonate,
      stopImpersonating,
      isImpersonating,
      activeStaff,
      activeRank,
      rankOf,
      maxRankAcross,
      sessionUser,
      sessionOrgAdminIds,
      sessionOrgOwnerIds,
      sessionOrgPermissions,
      hasOrgPermission,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      view,
      orgs,
      staff,
      activeStaffId,
      selectedOrgIds,
      publicSignedIn,
      orgsLoaded,
      profile,
      orgMembers,
      orgToxicity,
      orgPredefines,
      orgBanConfigs,
      orgMuteConfigs,
      orgTicketTypes,
      activeStaff,
      myOrgIds,
      manageableOrgIds,
      adminableOrgIds,
      realManageableOrgIds,
      realAdminableOrgIds,
      realStaff,
      isOwner,
      realIsOwner,
      hasStaffAccount,
      isImpersonating,
      viewingAs,
      activeRank,
      sessionOrgAdminIds,
      sessionOrgOwnerIds,
      sessionOrgPermissions,
      sessionUser,
    ],
  );
  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
}
function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
export {
  AuthProvider,
  BAN_CATEGORIES,
  BAN_CATEGORY_LABEL,
  TICKET_TYPE_KEYS,
  TICKET_TYPE_LABELS,
  useAuth,
};
