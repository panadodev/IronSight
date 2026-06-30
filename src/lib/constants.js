// Domain constants shared across the dashboard, sidebars, and auth context.
// These are static taxonomy values, not mock data — they define the application's
// staff tier structure and ticket vocabulary.

export const TEAM_META = {
  management: { label: "Management", rank: 4, short: "MGMT" },
  sr_admins: { label: "Sr. Admins", rank: 3, short: "SR" },
  admins: { label: "Admins", rank: 2, short: "ADM" },
  support: { label: "Support", rank: 1, short: "SUP" },
};

export const TEAM_IDS = ["management", "sr_admins", "admins", "support"];

export const STATUS_LABEL = {
  open: "Active",
  triage: "Active",
  in_progress: "Active",
  waiting_response: "Waiting",
  resolved: "Closed",
  closed: "Closed",
  cleared: "Cleared",
  banned: "Banned",
};

export const TICKET_TYPE_LABEL = {
  player_report: "Player Report",
  ban_appeal: "Ban Appeal",
  vip_issue: "VIP Issue",
  general_support: "General Support",
};

export const REPORT_CATEGORY_LABEL = {
  cheating: "Cheating",
  teaming: "Teaming",
  toxicity: "Toxicity",
  other: "Other",
};

// Default ticket type list. The dashboard will replace this with org-specific
// types fetched from GET /api/orgs/:orgId/ticket-types once loaded.
export const TICKET_TYPES = [
  { id: "player_report", label: "Player Report", team: "admins" },
  { id: "ban_appeal", label: "Ban Appeal", team: "sr_admins" },
  { id: "vip_issue", label: "VIP Issue", team: "management" },
  { id: "general_support", label: "General Support", team: "support" },
];

export const fmtNum = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US");
