const REPORT_CATEGORIES = [
  { id: "cheating", label: "Cheating", blurb: "Aimbot, ESP, scripts, macros." },
  {
    id: "teaming",
    label: "Teaming",
    blurb: "Group size violation / cross-team play.",
  },
  {
    id: "toxicity",
    label: "Toxicity",
    blurb: "Slurs, harassment, hate speech.",
  },
  { id: "other", label: "Other", blurb: "Rule break not covered above." },
];
const REPORT_CATEGORY_LABEL = {
  cheating: "Cheating",
  teaming: "Teaming",
  toxicity: "Toxicity",
  other: "Other",
};
const TEAM_META = {
  management: { label: "Management", rank: 4, short: "MGMT" },
  sr_admins: { label: "Sr. Admins", rank: 3, short: "SR" },
  admins: { label: "Admins", rank: 2, short: "ADM" },
  support: { label: "Support", rank: 1, short: "SUP" },
};
const TEAM_IDS = ["management", "sr_admins", "admins", "support"];
const TICKET_TYPES = [
  { id: "player_report", label: "Player Report", team: "admins" },
  { id: "ban_appeal", label: "Ban Appeal", team: "sr_admins" },
  { id: "vip_issue", label: "VIP Issue", team: "management" },
  { id: "general_support", label: "General Support", team: "support" },
];
const OWNER_STEAM_ID = "76561198186980425";
const STAFF = [
  {
    id: "u_zedge",
    name: "Zedge",
    role: "Owner",
    avatar: "Z",
    team: "management",
    steamId: OWNER_STEAM_ID,
    discordId: "zedge#0001",
  },
  {
    id: "u_bomb",
    name: "Bomb",
    role: "Management",
    avatar: "B",
    team: "management",
    steamId: "76561198840571152",
    discordId: "bomb#0001",
  },
  {
    id: "u_panado",
    name: "Panado",
    role: "Management",
    avatar: "P",
    team: "management",
    steamId: "76561198825911004",
    discordId: "panado#0001",
  },
  {
    id: "u_camomo",
    name: "CAMOMO_10",
    role: "Sr. Admin",
    avatar: "C",
    team: "sr_admins",
    steamId: "76561198103098115",
    discordId: "camomo#0001",
  },
  {
    id: "u_beans",
    name: "Beans",
    role: "Sr. Admin",
    avatar: "B",
    team: "sr_admins",
    steamId: "76561199069563414",
    discordId: "beans#0001",
  },
  {
    id: "u_potato",
    name: "PotatoAnimation",
    role: "Sr. Admin",
    avatar: "P",
    team: "sr_admins",
    steamId: "76561198122535245",
    discordId: "potato#0001",
  },
  {
    id: "u_brivis",
    name: "Brivis",
    role: "Sr. Admin",
    avatar: "B",
    team: "sr_admins",
    steamId: "76561199291812977",
    discordId: "brivis#0001",
  },
  {
    id: "u_olath",
    name: "OlathVlos",
    role: "Sr. Admin",
    avatar: "O",
    team: "sr_admins",
    steamId: "76561199084351346",
    discordId: "olath#0001",
  },
  {
    id: "u_kilometers",
    name: "Kilometers",
    role: "Admin",
    avatar: "K",
    team: "admins",
    steamId: "76561198808368287",
    discordId: "kilometers#0001",
  },
  {
    id: "u_bloo",
    name: "bloo",
    role: "Admin",
    avatar: "b",
    team: "admins",
    steamId: "76561199190472602",
    discordId: "bloo#0001",
  },
  {
    id: "u_common",
    name: "Common",
    role: "Admin",
    avatar: "C",
    team: "admins",
    steamId: "76561198880402724",
    discordId: "common#0001",
  },
  {
    id: "u_toadlord",
    name: "Toadlord",
    role: "Support",
    avatar: "T",
    team: "support",
    steamId: "76561198988575600",
    discordId: "toadlord#0001",
  },
  {
    id: "u_eagle",
    name: "Eagle",
    role: "Support",
    avatar: "E",
    team: "support",
    steamId: "76561198212390201",
    discordId: "eagle#0001",
  },
];
const PLAYERS = {
  "76561198000000001": {
    steamId: "76561198000000001",
    name: "[RU] NoLife",
    avatarColor: "oklch(0.45 0.15 30)",
    playtimeHours: 4291,
    accountAgeYears: 8.4,
    vacBans: 1,
    daysSinceLastBan: 240,
    lastSeen: "Now \u2014 Server 2",
    priorOffenses: 2,
    serverHoursThisWipe: 84,
    country: "RU",
    profileCreated: "2016-03-12",
  },
  "76561198000000002": {
    steamId: "76561198000000002",
    name: "DeathMask99",
    avatarColor: "oklch(0.5 0.12 200)",
    playtimeHours: 1240,
    accountAgeYears: 5.2,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "12m ago \u2014 Server 1",
    priorOffenses: 0,
    serverHoursThisWipe: 31,
    country: "US",
    profileCreated: "2019-08-04",
  },
  "76561198000000003": {
    steamId: "76561198000000003",
    name: "ToxicTim",
    avatarColor: "oklch(0.55 0.14 140)",
    playtimeHours: 612,
    accountAgeYears: 3.1,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "2h ago \u2014 Server 1",
    priorOffenses: 3,
    serverHoursThisWipe: 18,
    country: "GB",
    profileCreated: "2021-11-21",
  },
  "76561198000000004": {
    steamId: "76561198000000004",
    name: "BigGrub_99",
    avatarColor: "oklch(0.5 0.16 60)",
    playtimeHours: 3420,
    accountAgeYears: 7,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 2",
    priorOffenses: 0,
    serverHoursThisWipe: 56,
    country: "CA",
    profileCreated: "2017-06-30",
  },
  "76561198000000005": {
    steamId: "76561198000000005",
    name: "ShadowKiller",
    avatarColor: "oklch(0.4 0.08 280)",
    playtimeHours: 218,
    accountAgeYears: 1.2,
    vacBans: 2,
    daysSinceLastBan: 14,
    lastSeen: "5m ago \u2014 Server 1",
    priorOffenses: 4,
    serverHoursThisWipe: 9,
    country: "DE",
    profileCreated: "2023-09-02",
  },
  "76561198000000006": {
    steamId: "76561198000000006",
    name: "FennecFox",
    avatarColor: "oklch(0.55 0.18 50)",
    playtimeHours: 870,
    accountAgeYears: 4,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 1",
    priorOffenses: 1,
    serverHoursThisWipe: 22,
    country: "FR",
    profileCreated: "2020-04-18",
  },
  "76561198000000007": {
    steamId: "76561198000000007",
    name: "SaltMinerXD",
    avatarColor: "oklch(0.5 0.1 250)",
    playtimeHours: 1980,
    accountAgeYears: 6.1,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 2",
    priorOffenses: 0,
    serverHoursThisWipe: 42,
    country: "AU",
    profileCreated: "2018-10-09",
  },
  "76561198000000008": {
    steamId: "76561198000000008",
    name: "[SWE] Bjorn",
    avatarColor: "oklch(0.45 0.12 220)",
    playtimeHours: 3105,
    accountAgeYears: 9.2,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 3",
    priorOffenses: 0,
    serverHoursThisWipe: 71,
    country: "SE",
    profileCreated: "2015-09-01",
  },
  "76561198000000009": {
    steamId: "76561198000000009",
    name: "GhostLeaf",
    avatarColor: "oklch(0.5 0.14 160)",
    playtimeHours: 540,
    accountAgeYears: 2.4,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 3",
    priorOffenses: 0,
    serverHoursThisWipe: 12,
    country: "NL",
    profileCreated: "2022-08-15",
  },
  "76561198000000010": {
    steamId: "76561198000000010",
    name: "MeatTaco",
    avatarColor: "oklch(0.55 0.16 35)",
    playtimeHours: 2210,
    accountAgeYears: 5.8,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now \u2014 Server 3",
    priorOffenses: 2,
    serverHoursThisWipe: 38,
    country: "MX",
    profileCreated: "2019-02-22",
  },
  [OWNER_STEAM_ID]: {
    steamId: OWNER_STEAM_ID,
    name: "Helk",
    avatarColor: "oklch(0.55 0.18 25)",
    playtimeHours: 9999,
    accountAgeYears: 12,
    vacBans: 0,
    daysSinceLastBan: null,
    lastSeen: "Now",
    priorOffenses: 0,
    serverHoursThisWipe: 0,
    country: "CA",
    profileCreated: "2013-01-01",
  },
};
function getPlayer(steamId) {
  return (
    PLAYERS[steamId] ?? {
      steamId,
      name: "Unknown Player",
      avatarColor: "oklch(0.4 0.02 285)",
      playtimeHours: 0,
      accountAgeYears: 0,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Never",
      priorOffenses: 0,
      serverHoursThisWipe: 0,
      country: "??",
      profileCreated: "\u2014",
    }
  );
}
const SERVERS = [
  {
    id: "srv1",
    name: "[EU] Main 5x Solo/Duo",
    region: "Frankfurt",
    orgId: "builders_sanctuary",
    playerIds: [
      "76561198000000002",
      "76561198000000003",
      "76561198000000005",
      "76561198000000006",
    ],
  },
  {
    id: "srv2",
    name: "[NA] Vanilla Trio",
    region: "Chicago",
    orgId: "builders_sanctuary",
    playerIds: ["76561198000000001", "76561198000000004", "76561198000000007"],
  },
  {
    id: "srv3",
    name: "[EU] 2x Modded",
    region: "Stockholm",
    orgId: "willjums",
    playerIds: ["76561198000000008", "76561198000000009", "76561198000000010"],
  },
];
function getServerPlayers(serverId) {
  const server = SERVERS.find((s) => s.id === serverId);
  if (!server) return [];
  return server.playerIds.map(getPlayer);
}
function getTeammates(steamId) {
  let h = 0;
  for (let i = 0; i < steamId.length; i++)
    h = (h * 31 + steamId.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const pool = Object.keys(PLAYERS).filter(
    (id) => id !== steamId && id !== OWNER_STEAM_ID,
  );
  const count = (h % 4) + 1;
  const joinedOptions = [
    "2m ago",
    "14m ago",
    "1h ago",
    "3h ago",
    "yesterday",
    "2d ago",
    "1w ago",
  ];
  const out = [];
  for (let i = 0; i < count + 2 && out.length < count; i++) {
    const k = Math.abs((h + i * 977) | 0);
    const pid = pool[k % pool.length];
    if (out.some((t) => t.player.steamId === pid)) continue;
    out.push({
      player: getPlayer(pid),
      online: k % 3 !== 0,
      joinedLabel: joinedOptions[k % joinedOptions.length],
    });
  }
  return out;
}
function getPreviousTeammates(steamId) {
  let h = 0;
  for (let i = 0; i < steamId.length; i++)
    h = (h * 31 + steamId.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const current = new Set(getTeammates(steamId).map((m) => m.player.steamId));
  const pool = Object.keys(PLAYERS).filter(
    (id) => id !== steamId && id !== OWNER_STEAM_ID && !current.has(id),
  );
  const count = (h % 4) + 2;
  const leftOptions = [
    { label: "8m ago", sec: 8 * 60 },
    { label: "27m ago", sec: 27 * 60 },
    { label: "1h ago", sec: 60 * 60 },
    { label: "4h ago", sec: 4 * 3600 },
    { label: "yesterday", sec: 86400 },
    { label: "2d ago", sec: 2 * 86400 },
    { label: "5d ago", sec: 5 * 86400 },
    { label: "2w ago", sec: 14 * 86400 },
    { label: "1mo ago", sec: 30 * 86400 },
  ];
  const out = [];
  for (let i = 0; i < count + 4 && out.length < count && pool.length > 0; i++) {
    const k = Math.abs((h + i * 1597) | 0);
    const pid = pool[k % pool.length];
    if (out.some((t) => t.player.steamId === pid)) continue;
    const opt = leftOptions[k % leftOptions.length];
    out.push({
      player: getPlayer(pid),
      leftLabel: opt.label,
      leftSec: opt.sec,
    });
  }
  return out.sort((a, b) => a.leftSec - b.leftSec);
}
const TICKETS = [
  {
    id: "t_4902",
    number: 4902,
    type: "player_report",
    category: "cheating",
    team: "admins",
    status: "open",
    priority: "urgent",
    title: "Cheating \u2014 [RU] NoLife",
    summary:
      "Aggregated cheating case against [RU] NoLife. Multiple players have reported pre-firing, tracking through walls, and unrealistic accuracy at long range.",
    createdAt: "2026-05-25T14:20:00Z",
    createdLabel: "4m ago",
    reporterId: "76561198000000002",
    subjectId: "76561198000000001",
    serverId: "srv2",
    assigneeId: null,
    restrictedRank: null,
    messages: [
      {
        authorId: "system",
        authorName: "System",
        authorKind: "system",
        timestamp: "14:13",
        body: "Combat audit initiated for 76561198000000001. Average hit distance 184.2m. Accuracy 88%.",
      },
      {
        authorId: "system",
        authorName: "Thorium Anti-Cheat",
        authorKind: "system",
        timestamp: "14:16",
        body: "[THORIUM ALERT \xB7 SilentAim] [88%] Detected 7/9 shot frames with aim correction that disagreed with raw mouse input (78%). Zero-mouse: 6, opposite-mouse: 0, max deviation: 38.0\xB0, avg hit distance: 7.6m [outlier:0.98\u21920.88]",
      },
      {
        authorId: "system",
        authorName: "F7 Report",
        authorKind: "system",
        timestamp: "14:19",
        body: '[F7 REPORT] Reporter: BigGrub_99 \xB7 Subject: [RU] NoLife \xB7 Description: "walling through stone at our base, prefires every corner"',
      },
      {
        authorId: "system",
        authorName: "Thorium Anti-Cheat",
        authorKind: "system",
        timestamp: "14:22",
        body: "[THORIUM ALERT \xB7 DebugCameraA] [96%] Detected 28 debug camera violations. Eye detached from body by up to 229.5m while stationary. Total eye movement: 5590.9m",
      },
    ],
    reports: [
      {
        id: "r_1",
        reporterId: "76561198000000002",
        description:
          "Beamed three of us from over 200m with an AK while we were on the boat coming back from Large Oil. All headshots. He is at coordinate G14.",
        evidence: "https://medal.tv/clip/abc123\nhttps://medal.tv/clip/abc124",
        submittedAt: "2026-05-25T14:12:00Z",
        submittedLabel: "12m ago",
        status: "pending",
      },
      {
        id: "r_2",
        reporterId: "76561198000000004",
        description:
          "Same guy pre-fired me around a rock at Launch Site. He had no line of sight before I peeked.",
        evidence: "",
        submittedAt: "2026-05-25T14:18:00Z",
        submittedLabel: "6m ago",
        status: "pending",
      },
      {
        id: "r_3",
        reporterId: "76561198000000007",
        description:
          "He killed me through a stone wall at our base. Heard footsteps then died instantly.",
        evidence: "https://youtu.be/wallbang-clip",
        submittedAt: "2026-05-25T14:19:30Z",
        submittedLabel: "4m ago",
        status: "pending",
      },
    ],
  },
  {
    id: "t_4903",
    number: 4903,
    type: "player_report",
    category: "teaming",
    team: "admins",
    status: "open",
    priority: "high",
    title: "Teaming \u2014 [RU] NoLife",
    summary:
      "Reports that [RU] NoLife is running with a 4-stack on a duo server. Same player as #4902 but a separate rule violation.",
    createdAt: "2026-05-25T13:45:00Z",
    createdLabel: "39m ago",
    reporterId: "76561198000000004",
    subjectId: "76561198000000001",
    serverId: "srv2",
    assigneeId: null,
    restrictedRank: null,
    messages: [],
    reports: [
      {
        id: "r_t1",
        reporterId: "76561198000000004",
        description:
          "Saw him at Outpost loading loot into a chopper with three other players \u2014 none on his team according to /team.",
        evidence: "https://i.imgur.com/teaming-outpost.png",
        submittedAt: "2026-05-25T13:45:00Z",
        submittedLabel: "39m ago",
        status: "pending",
      },
    ],
  },
  {
    id: "t_4904",
    number: 4904,
    type: "player_report",
    category: "toxicity",
    team: "admins",
    status: "open",
    priority: "normal",
    title: "Toxicity \u2014 ToxicTim",
    summary:
      "Multiple reports of slurs and harassment in global chat across several sessions.",
    createdAt: "2026-05-25T11:20:00Z",
    createdLabel: "3h ago",
    reporterId: "76561198000000006",
    subjectId: "76561198000000003",
    serverId: "srv1",
    assigneeId: null,
    restrictedRank: null,
    messages: [],
    reports: [
      {
        id: "r_tox1",
        reporterId: "76561198000000006",
        description:
          "Spamming slurs in global chat after we raided his base. Continued for ~15 minutes despite asking him to stop.",
        evidence: "https://i.imgur.com/chatlog-toxictim.png",
        submittedAt: "2026-05-25T11:20:00Z",
        submittedLabel: "3h ago",
        status: "pending",
      },
      {
        id: "r_tox2",
        reporterId: "76561198000000009",
        description:
          "Same player went off on me in voice chat at Bandit. Hate speech and threats. Have the clip below.",
        evidence: "https://medal.tv/clip/tox-bandit-99",
        submittedAt: "2026-05-25T11:42:00Z",
        submittedLabel: "2h ago",
        status: "pending",
      },
    ],
  },
  {
    id: "t_4905",
    number: 4905,
    type: "player_report",
    category: "other",
    team: "admins",
    status: "open",
    priority: "low",
    title: "Other \u2014 MeatTaco (base griefing / sign spam)",
    summary:
      "Player allegedly placing offensive signs around neighbor bases and blocking TC access with twig.",
    createdAt: "2026-05-25T07:55:00Z",
    createdLabel: "7h ago",
    reporterId: "76561198000000008",
    subjectId: "76561198000000010",
    serverId: "srv3",
    assigneeId: null,
    restrictedRank: null,
    messages: [],
    reports: [
      {
        id: "r_oth1",
        reporterId: "76561198000000008",
        description:
          "MeatTaco walled off our TC with twig after we let him into the compound. Also placed signs with offensive imagery on our walls.",
        evidence: "https://i.imgur.com/griefing-signs.png",
        submittedAt: "2026-05-25T07:55:00Z",
        submittedLabel: "7h ago",
        status: "pending",
      },
    ],
  },
  {
    id: "t_4901",
    number: 4901,
    type: "ban_appeal",
    team: "sr_admins",
    status: "in_progress",
    priority: "normal",
    title: "Appealing temporary mute for toxicity",
    summary:
      "Argues the mute was excessive \u2014 friend-banter context in global chat.",
    createdAt: "2026-05-25T12:05:00Z",
    createdLabel: "2h ago",
    reporterId: "76561198000000003",
    subjectId: "76561198000000003",
    serverId: "srv1",
    assigneeId: "u_camomo",
    restrictedRank: null,
    messages: [
      {
        authorId: "76561198000000003",
        authorName: "ToxicTim",
        authorKind: "reporter",
        timestamp: "12:05",
        body: "I was just joking with my friends in global chat, I didn't mean to break the rules. Please review the chat logs in context.",
      },
      {
        authorId: "u_camomo",
        authorName: "CAMOMO_10",
        authorKind: "staff",
        timestamp: "12:48",
        body: "Reviewed the logs. The mute was for repeated slurs, not banter. Reducing duration to 24h as a one-time gesture.",
      },
    ],
  },
  {
    id: "t_4900",
    number: 4900,
    type: "vip_issue",
    team: "management",
    status: "open",
    priority: "high",
    title: "VIP kit not received after purchase",
    summary:
      "Paid for VIP Gold tier \u2014 never received in-game kit after restart.",
    createdAt: "2026-05-25T10:45:00Z",
    createdLabel: "3h ago",
    reporterId: "76561198000000004",
    subjectId: "76561198000000004",
    serverId: "srv2",
    assigneeId: "u_bomb",
    restrictedRank: 4,
    messages: [
      {
        authorId: "76561198000000004",
        authorName: "BigGrub_99",
        authorKind: "reporter",
        timestamp: "10:45",
        body: "Bought VIP Gold yesterday via PayPal (txn 2K8-44291). Tried /kit vip in-game \u2014 says I don't have permissions. Restarted twice.",
      },
    ],
  },
  {
    id: "t_4899",
    number: 4899,
    type: "general_support",
    team: "support",
    status: "in_progress",
    priority: "low",
    title: "Stuck in base honeycomb",
    summary:
      "Player TP request \u2014 clipped into 2x2 honeycomb wall after raid.",
    createdAt: "2026-05-25T09:30:00Z",
    createdLabel: "5h ago",
    reporterId: "76561198000000002",
    subjectId: null,
    serverId: "srv1",
    assigneeId: "u_toadlord",
    restrictedRank: null,
    messages: [
      {
        authorId: "76561198000000002",
        authorName: "DeathMask99",
        authorKind: "reporter",
        timestamp: "09:30",
        body: "Got rolled back into a 2x2 wall in our raid base. Coordinates K18. Sleeping bag is outside. Need a teleport please.",
      },
    ],
  },
  {
    id: "t_4895",
    number: 4895,
    type: "player_report",
    category: "cheating",
    team: "admins",
    status: "open",
    priority: "high",
    title: "Cheating \u2014 ShadowKiller",
    summary:
      "Suspect was VAC-banned 14 days ago on alt \u2014 now camping our tool cupboard.",
    createdAt: "2026-05-25T08:10:00Z",
    createdLabel: "7h ago",
    reporterId: "76561198000000004",
    subjectId: "76561198000000005",
    serverId: "srv1",
    assigneeId: null,
    restrictedRank: null,
    messages: [
      {
        authorId: "system",
        authorName: "F7 Report",
        authorKind: "system",
        timestamp: "08:14",
        body: '[F7 REPORT] Reporter: BigGrub_99 \xB7 Subject: ShadowKiller \xB7 Description: "camping tool cupboard all wipe, snap-aims through walls"',
      },
    ],
    reports: [
      {
        id: "r_a",
        reporterId: "76561198000000004",
        description:
          "Pretty sure this is the same player we reported last wipe. Same playstyle, recent VAC ban on profile, account barely a year old.",
        evidence: "",
        submittedAt: "2026-05-25T08:10:00Z",
        submittedLabel: "7h ago",
        status: "pending",
      },
    ],
  },
];
(function seedSpreadAlerts() {
  const t = TICKETS.find((x) => x.id === "t_4902");
  if (!t) return;
  const NOW = Date.parse("2026-05-26T12:00:00Z");
  const samples = [
    {
      days: 1,
      hour: 22,
      kind: "f7",
      body: '[F7 REPORT] Reporter: SaltyBean \xB7 Subject: [RU] NoLife \xB7 Description: "insta-headshot from 180m, no scope sway"',
    },
    {
      days: 3,
      hour: 4,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 NoRecoil] [82%] Vertical recoil compensation 96% across 42 shots. Max drift 0.4\xB0.",
    },
    {
      days: 5,
      hour: 18,
      kind: "f7",
      body: '[F7 REPORT] Reporter: TundraFox \xB7 Description: "wallbanged me through 2x metal at compound"',
    },
    {
      days: 8,
      hour: 11,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 SilentAim] [91%] 12/14 shots corrected mid-flight, opposite-mouse: 3.",
    },
    {
      days: 11,
      hour: 2,
      kind: "f7",
      body: '[F7 REPORT] Reporter: GhostlyPete \xB7 Description: "tracking me through walls again, third time tonight"',
    },
    {
      days: 14,
      hour: 20,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 DebugCameraA] [88%] Eye detached 120m while prone in bush.",
    },
    {
      days: 18,
      hour: 14,
      kind: "f7",
      body: '[F7 REPORT] Reporter: Karen44 \xB7 Description: "prefires every angle at Launch Site"',
    },
    {
      days: 22,
      hour: 9,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 AimSnap] [94%] Snap-to-head within 1 frame across 8 engagements.",
    },
    {
      days: 26,
      hour: 23,
      kind: "f7",
      body: '[F7 REPORT] Reporter: BigGrub_99 \xB7 Description: "snap aim from roof camp, no warning"',
    },
    {
      days: 31,
      hour: 6,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 NoRecoil] [85%] AKM full-auto with 2.1\xB0 vertical drift over 60 rounds.",
    },
    {
      days: 36,
      hour: 15,
      kind: "f7",
      body: '[F7 REPORT] Reporter: DeathMask99 \xB7 Description: "third report this wipe, same player same playstyle"',
    },
    {
      days: 41,
      hour: 1,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 SilentAim] [78%] Reticle disagreement on 6/10 frames, deviation 22\xB0.",
    },
    {
      days: 45,
      hour: 19,
      kind: "f7",
      body: '[F7 REPORT] Reporter: TwoTapTom \xB7 Description: "shot me from inside a rock at Dome"',
    },
    {
      days: 50,
      hour: 12,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 DebugCameraA] [97%] 41 debug camera violations in 6 minutes, max range 229m.",
    },
    {
      days: 55,
      hour: 7,
      kind: "f7",
      body: '[F7 REPORT] Reporter: SaltyBean \xB7 Description: "obvious aim assist, beaming across map"',
    },
    {
      days: 60,
      hour: 21,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 AimSnap] [89%] Sub-frame snap on 5 separate kills, all headshots.",
    },
    {
      days: 65,
      hour: 3,
      kind: "f7",
      body: '[F7 REPORT] Reporter: Karen44 \xB7 Description: "hit me through a triangle ceiling"',
    },
    {
      days: 70,
      hour: 17,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 NoRecoil] [80%] LR-300 burst pattern within 0.4\xB0 envelope, 7 bursts.",
    },
    {
      days: 75,
      hour: 10,
      kind: "f7",
      body: '[F7 REPORT] Reporter: GhostlyPete \xB7 Description: "impossible flicks, 180\xB0 in 2 frames"',
    },
    {
      days: 80,
      hour: 0,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 SilentAim] [86%] Correction frames detected on 9 engagements.",
    },
    {
      days: 84,
      hour: 16,
      kind: "f7",
      body: '[F7 REPORT] Reporter: TundraFox \xB7 Description: "camping us from afar with one-taps"',
    },
    {
      days: 88,
      hour: 8,
      kind: "thorium",
      body: "[THORIUM ALERT \xB7 DebugCameraA] [92%] Eye detachment up to 310m, total movement 8.2km.",
    },
  ];
  for (const s of samples) {
    const iso = new Date(NOW - s.days * 864e5 + s.hour * 36e5).toISOString();
    t.messages.push({
      authorId: "system",
      authorName: s.kind === "f7" ? "F7 Report" : "Thorium Anti-Cheat",
      authorKind: "system",
      timestamp: iso.slice(11, 16),
      occurredAt: iso,
      body: s.body,
    });
  }
})();
(function seedExtraData() {
  const extraPlayers = [
    {
      steamId: "76561198000000011",
      name: "PixelWraith",
      avatarColor: "oklch(0.5 0.14 290)",
      playtimeHours: 1542,
      accountAgeYears: 4.7,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "23m ago \u2014 Server 1",
      priorOffenses: 1,
      serverHoursThisWipe: 26,
      country: "PL",
      profileCreated: "2020-09-12",
    },
    {
      steamId: "76561198000000012",
      name: "QuietStorm",
      avatarColor: "oklch(0.45 0.1 210)",
      playtimeHours: 3890,
      accountAgeYears: 8.9,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 3",
      priorOffenses: 0,
      serverHoursThisWipe: 64,
      country: "NO",
      profileCreated: "2015-12-04",
    },
    {
      steamId: "76561198000000013",
      name: "NoobSlayer420",
      avatarColor: "oklch(0.55 0.18 20)",
      playtimeHours: 142,
      accountAgeYears: 0.4,
      vacBans: 1,
      daysSinceLastBan: 3,
      lastSeen: "Now \u2014 Server 1",
      priorOffenses: 2,
      serverHoursThisWipe: 19,
      country: "RO",
      profileCreated: "2024-12-30",
    },
    {
      steamId: "76561198000000014",
      name: "[CAN] MapleSyrup",
      avatarColor: "oklch(0.5 0.12 25)",
      playtimeHours: 2740,
      accountAgeYears: 6.5,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "1h ago \u2014 Server 2",
      priorOffenses: 0,
      serverHoursThisWipe: 48,
      country: "CA",
      profileCreated: "2018-06-15",
    },
    {
      steamId: "76561198000000015",
      name: "Yuki_Chan",
      avatarColor: "oklch(0.6 0.16 340)",
      playtimeHours: 980,
      accountAgeYears: 3.3,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 2",
      priorOffenses: 0,
      serverHoursThisWipe: 33,
      country: "JP",
      profileCreated: "2021-08-22",
    },
    {
      steamId: "76561198000000016",
      name: "ScrapBaron",
      avatarColor: "oklch(0.45 0.11 75)",
      playtimeHours: 5120,
      accountAgeYears: 10.1,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 3",
      priorOffenses: 1,
      serverHoursThisWipe: 91,
      country: "DK",
      profileCreated: "2014-07-01",
    },
    {
      steamId: "76561198000000017",
      name: "LowFPS",
      avatarColor: "oklch(0.4 0.06 270)",
      playtimeHours: 312,
      accountAgeYears: 1.8,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "4h ago \u2014 Server 1",
      priorOffenses: 0,
      serverHoursThisWipe: 14,
      country: "BR",
      profileCreated: "2023-04-11",
    },
    {
      steamId: "76561198000000018",
      name: "RageQuit_R",
      avatarColor: "oklch(0.5 0.18 15)",
      playtimeHours: 730,
      accountAgeYears: 2.9,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 1",
      priorOffenses: 5,
      serverHoursThisWipe: 27,
      country: "US",
      profileCreated: "2022-04-02",
    },
    {
      steamId: "76561198000000019",
      name: "[FIN] Kiviniemi",
      avatarColor: "oklch(0.45 0.1 230)",
      playtimeHours: 4410,
      accountAgeYears: 9.5,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 3",
      priorOffenses: 0,
      serverHoursThisWipe: 77,
      country: "FI",
      profileCreated: "2015-02-20",
    },
    {
      steamId: "76561198000000020",
      name: "SilentTurret",
      avatarColor: "oklch(0.4 0.09 200)",
      playtimeHours: 188,
      accountAgeYears: 0.9,
      vacBans: 1,
      daysSinceLastBan: 28,
      lastSeen: "Now \u2014 Server 2",
      priorOffenses: 3,
      serverHoursThisWipe: 11,
      country: "DE",
      profileCreated: "2024-06-30",
    },
    {
      steamId: "76561198000000021",
      name: "GrumpyOldGoat",
      avatarColor: "oklch(0.5 0.08 90)",
      playtimeHours: 6230,
      accountAgeYears: 11.3,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 2",
      priorOffenses: 0,
      serverHoursThisWipe: 102,
      country: "GB",
      profileCreated: "2013-08-15",
    },
    {
      steamId: "76561198000000022",
      name: "Nyx",
      avatarColor: "oklch(0.4 0.12 310)",
      playtimeHours: 1670,
      accountAgeYears: 4.2,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 1",
      priorOffenses: 0,
      serverHoursThisWipe: 41,
      country: "IT",
      profileCreated: "2020-12-19",
    },
    {
      steamId: "76561198000000023",
      name: "ZeroPing",
      avatarColor: "oklch(0.55 0.14 180)",
      playtimeHours: 2050,
      accountAgeYears: 5.6,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "12m ago \u2014 Server 3",
      priorOffenses: 1,
      serverHoursThisWipe: 36,
      country: "KR",
      profileCreated: "2019-07-08",
    },
    {
      steamId: "76561198000000024",
      name: "Crouch_Walker",
      avatarColor: "oklch(0.5 0.1 130)",
      playtimeHours: 420,
      accountAgeYears: 2.1,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 2",
      priorOffenses: 0,
      serverHoursThisWipe: 17,
      country: "ES",
      profileCreated: "2023-01-22",
    },
    {
      steamId: "76561198000000025",
      name: "VodkaBear",
      avatarColor: "oklch(0.45 0.13 40)",
      playtimeHours: 3320,
      accountAgeYears: 7.8,
      vacBans: 0,
      daysSinceLastBan: null,
      lastSeen: "Now \u2014 Server 2",
      priorOffenses: 2,
      serverHoursThisWipe: 58,
      country: "RU",
      profileCreated: "2017-04-09",
    },
  ];
  for (const p of extraPlayers) PLAYERS[p.steamId] = p;
  const NOW = Date.parse("2026-05-26T12:00:00Z");
  const iso = (mins) => new Date(NOW - mins * 6e4).toISOString();
  const hm = (mins) => iso(mins).slice(11, 16);
  const moreTickets = [
    // ---- Player Reports ----
    {
      id: "t_4906",
      number: 4906,
      type: "player_report",
      category: "cheating",
      team: "admins",
      status: "open",
      priority: "high",
      title: "Cheating \u2014 NoobSlayer420",
      summary:
        "Fresh account, recent VAC, instant headshots from extreme range.",
      createdAt: iso(95),
      createdLabel: "1h ago",
      reporterId: "76561198000000014",
      subjectId: "76561198000000013",
      serverId: "srv1",
      assigneeId: null,
      restrictedRank: null,
      messages: [
        {
          authorId: "system",
          authorName: "Thorium Anti-Cheat",
          authorKind: "system",
          timestamp: hm(94),
          body: "[THORIUM ALERT \xB7 AimSnap] [93%] Sub-frame snap on 4 kills, all headshots.",
        },
      ],
      reports: [
        {
          id: "r_4906a",
          reporterId: "76561198000000014",
          description:
            "Killed me at 220m through a smoke with an SAR. No tracers, no audio cue. Account is 4 months old.",
          evidence: "https://medal.tv/clip/noob420",
          submittedAt: iso(95),
          submittedLabel: "1h ago",
          status: "pending",
        },
        {
          id: "r_4906b",
          reporterId: "76561198000000011",
          description:
            "Same player wallbanged us at Mil Tunnels. Pre-aimed exact spot.",
          evidence: "",
          submittedAt: iso(60),
          submittedLabel: "1h ago",
          status: "pending",
        },
      ],
    },
    {
      id: "t_4907",
      number: 4907,
      type: "player_report",
      category: "toxicity",
      team: "admins",
      status: "banned",
      priority: "normal",
      title: "Toxicity \u2014 RageQuit_R",
      summary: "Slurs in voice and global. Closed: 7-day mute issued.",
      createdAt: iso(60 * 26),
      createdLabel: "1d ago",
      reporterId: "76561198000000015",
      subjectId: "76561198000000018",
      serverId: "srv1",
      assigneeId: "u_kilometers",
      restrictedRank: null,
      messages: [],
      reports: [
        {
          id: "r_4907a",
          reporterId: "76561198000000015",
          description:
            "Constant slurs in voice for an hour straight, ignored my mute warnings.",
          evidence: "https://medal.tv/clip/rage-voice",
          submittedAt: iso(60 * 26),
          submittedLabel: "1d ago",
          status: "banned",
        },
      ],
    },
    {
      id: "t_4908",
      number: 4908,
      type: "player_report",
      category: "teaming",
      team: "admins",
      status: "cleared",
      priority: "low",
      title: "Teaming \u2014 Yuki_Chan",
      summary:
        "Alleged duo-teaming on solo server. Cleared after review (legitimate trade at outpost).",
      createdAt: iso(60 * 48),
      createdLabel: "2d ago",
      reporterId: "76561198000000017",
      subjectId: "76561198000000015",
      serverId: "srv1",
      assigneeId: "u_bloo",
      restrictedRank: null,
      messages: [],
      reports: [
        {
          id: "r_4908a",
          reporterId: "76561198000000017",
          description:
            "Saw her loot a body together with another player at Outpost.",
          evidence: "",
          submittedAt: iso(60 * 48),
          submittedLabel: "2d ago",
          status: "case_closed",
        },
      ],
    },
    {
      id: "t_4909",
      number: 4909,
      type: "player_report",
      category: "cheating",
      team: "admins",
      status: "open",
      priority: "urgent",
      title: "Cheating \u2014 SilentTurret",
      summary:
        "Multiple Thorium silent-aim hits, account 9 months old with prior VAC.",
      createdAt: iso(22),
      createdLabel: "22m ago",
      reporterId: "76561198000000019",
      subjectId: "76561198000000020",
      serverId: "srv2",
      assigneeId: null,
      restrictedRank: null,
      messages: [
        {
          authorId: "system",
          authorName: "Thorium Anti-Cheat",
          authorKind: "system",
          timestamp: hm(20),
          body: "[THORIUM ALERT \xB7 SilentAim] [95%] 11/12 shots corrected mid-flight, opposite-mouse: 4.",
        },
      ],
      reports: [
        {
          id: "r_4909a",
          reporterId: "76561198000000019",
          description:
            "Beamed our whole trio from a bush at 180m. No sound, headshots only.",
          evidence: "https://medal.tv/clip/silent-turret",
          submittedAt: iso(22),
          submittedLabel: "22m ago",
          status: "pending",
        },
      ],
    },
    {
      id: "t_4910",
      number: 4910,
      type: "player_report",
      category: "other",
      team: "admins",
      status: "open",
      priority: "normal",
      title: "Other \u2014 ScrapBaron (door camping AFK)",
      summary:
        "AFK turret-style door camping reported by neighbors. Possibly automated.",
      createdAt: iso(60 * 5),
      createdLabel: "5h ago",
      reporterId: "76561198000000012",
      subjectId: "76561198000000016",
      serverId: "srv3",
      assigneeId: "u_bloo",
      restrictedRank: null,
      messages: [],
      reports: [
        {
          id: "r_4910a",
          reporterId: "76561198000000012",
          description:
            "Stood in the same spot for 6+ hours auto-shooting anyone who passed. No movement, no chat replies.",
          evidence: "https://i.imgur.com/afk-camp.png",
          submittedAt: iso(60 * 5),
          submittedLabel: "5h ago",
          status: "pending",
        },
      ],
    },
    // ---- Ban Appeals ----
    {
      id: "t_4911",
      number: 4911,
      type: "ban_appeal",
      team: "sr_admins",
      status: "open",
      priority: "normal",
      title: "Appealing 30-day ban for teaming",
      summary:
        "Claims the 4th player was a random they had just met and weren't actually teaming.",
      createdAt: iso(180),
      createdLabel: "3h ago",
      reporterId: "76561198000000018",
      subjectId: "76561198000000018",
      serverId: "srv1",
      assigneeId: null,
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000018",
          authorName: "RageQuit_R",
          authorKind: "reporter",
          timestamp: hm(180),
          body: "I wasn't teaming. The 4th guy just joined our base because we found him naked. We didn't share loot.",
        },
      ],
    },
    {
      id: "t_4912",
      number: 4912,
      type: "ban_appeal",
      team: "sr_admins",
      status: "waiting_response",
      priority: "low",
      title: "Appeal \u2014 VAC ban reset request",
      summary: "Old VAC on alt account, requesting whitelist for main.",
      createdAt: iso(60 * 18),
      createdLabel: "18h ago",
      reporterId: "76561198000000013",
      subjectId: "76561198000000013",
      serverId: null,
      assigneeId: "u_beans",
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000013",
          authorName: "NoobSlayer420",
          authorKind: "reporter",
          timestamp: hm(60 * 18),
          body: "My VAC is from CS:GO in 2020, nothing to do with Rust. Please whitelist me.",
        },
        {
          authorId: "u_beans",
          authorName: "Beans",
          authorKind: "staff",
          timestamp: hm(60 * 12),
          body: "Can you share the original VAC details (game, date) and any prior bans on this account?",
        },
      ],
    },
    {
      id: "t_4913",
      number: 4913,
      type: "ban_appeal",
      team: "sr_admins",
      status: "closed",
      priority: "normal",
      title: "Appeal denied \u2014 cheating ban upheld",
      summary:
        "Appeal reviewed with replay; aim assist clearly visible. Ban upheld.",
      createdAt: iso(60 * 72),
      createdLabel: "3d ago",
      reporterId: "76561198000000005",
      subjectId: "76561198000000005",
      serverId: "srv1",
      assigneeId: "u_camomo",
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000005",
          authorName: "ShadowKiller",
          authorKind: "reporter",
          timestamp: hm(60 * 72),
          body: "I don't cheat. Please look at my POV.",
        },
        {
          authorId: "u_camomo",
          authorName: "CAMOMO_10",
          authorKind: "staff",
          timestamp: hm(60 * 60),
          body: "Reviewed POV + server demo. Cursor snaps directly to head on 6 separate engagements. Appeal denied.",
        },
      ],
    },
    // ---- VIP Issues ----
    {
      id: "t_4914",
      number: 4914,
      type: "vip_issue",
      team: "management",
      status: "open",
      priority: "normal",
      title: "VIP queue priority not working",
      summary: "Gold VIP \u2014 queue priority not applied on EU Main.",
      createdAt: iso(40),
      createdLabel: "40m ago",
      reporterId: "76561198000000021",
      subjectId: "76561198000000021",
      serverId: "srv1",
      assigneeId: null,
      restrictedRank: 4,
      messages: [
        {
          authorId: "76561198000000021",
          authorName: "GrumpyOldGoat",
          authorKind: "reporter",
          timestamp: hm(40),
          body: "Waited 22 minutes in queue today with Gold VIP. Same as last wipe \u2014 fix please.",
        },
      ],
    },
    {
      id: "t_4915",
      number: 4915,
      type: "vip_issue",
      team: "management",
      status: "in_progress",
      priority: "high",
      title: "Double charge on Silver VIP",
      summary: "Stripe shows two charges for the same purchase. Refund needed.",
      createdAt: iso(60 * 8),
      createdLabel: "8h ago",
      reporterId: "76561198000000014",
      subjectId: "76561198000000014",
      serverId: null,
      assigneeId: "u_bomb",
      restrictedRank: 4,
      messages: [
        {
          authorId: "76561198000000014",
          authorName: "[CAN] MapleSyrup",
          authorKind: "reporter",
          timestamp: hm(60 * 8),
          body: "Charged twice for the same Silver tier purchase. Stripe txn IDs ch_3PaQ... and ch_3PaR...",
        },
        {
          authorId: "u_bomb",
          authorName: "Bomb",
          authorKind: "staff",
          timestamp: hm(60 * 6),
          body: "Confirmed in Stripe dashboard. Issuing refund for the duplicate now.",
        },
      ],
    },
    {
      id: "t_4916",
      number: 4916,
      type: "vip_issue",
      team: "management",
      status: "resolved",
      priority: "low",
      title: "VIP kit cooldown bug \u2014 fixed",
      summary: "Kit cooldown was 24h instead of 12h for Gold. Patched.",
      createdAt: iso(60 * 96),
      createdLabel: "4d ago",
      reporterId: "76561198000000019",
      subjectId: "76561198000000019",
      serverId: "srv3",
      assigneeId: "u_bomb",
      restrictedRank: 4,
      messages: [
        {
          authorId: "76561198000000019",
          authorName: "[FIN] Kiviniemi",
          authorKind: "reporter",
          timestamp: hm(60 * 96),
          body: "/kit vipgold says 24h cooldown but the perks page says 12h.",
        },
        {
          authorId: "u_bomb",
          authorName: "Bomb",
          authorKind: "staff",
          timestamp: hm(60 * 80),
          body: "Confirmed config error, pushed fix. Try /kit vipgold now.",
        },
      ],
    },
    // ---- General Support ----
    {
      id: "t_4917",
      number: 4917,
      type: "general_support",
      team: "support",
      status: "open",
      priority: "normal",
      title: "Lost loot from server rollback",
      summary:
        "Server rolled back 18 minutes; lost a full kit from a heli kill.",
      createdAt: iso(75),
      createdLabel: "1h ago",
      reporterId: "76561198000000022",
      subjectId: null,
      serverId: "srv1",
      assigneeId: null,
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000022",
          authorName: "Nyx",
          authorKind: "reporter",
          timestamp: hm(75),
          body: "Killed a heli, looted everything, then server rolled back and it's all gone. Can you restore?",
        },
      ],
    },
    {
      id: "t_4918",
      number: 4918,
      type: "general_support",
      team: "support",
      status: "waiting_response",
      priority: "low",
      title: "Can't connect \u2014 EAC error 12",
      summary: "Recurring EAC error 12 on launch; standard fixes attempted.",
      createdAt: iso(60 * 4),
      createdLabel: "4h ago",
      reporterId: "76561198000000024",
      subjectId: null,
      serverId: null,
      assigneeId: "u_eagle",
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000024",
          authorName: "Crouch_Walker",
          authorKind: "reporter",
          timestamp: hm(60 * 4),
          body: "Getting EAC error 12 every time I launch. Verified files twice.",
        },
        {
          authorId: "u_eagle",
          authorName: "Eagle",
          authorKind: "staff",
          timestamp: hm(60 * 3),
          body: "Please try reinstalling EAC from steamapps/common/Rust/EasyAntiCheat/EasyAntiCheat_Setup.exe and let me know.",
        },
      ],
    },
    {
      id: "t_4919",
      number: 4919,
      type: "general_support",
      team: "support",
      status: "resolved",
      priority: "low",
      title: "Restored TC after raid glitch",
      summary:
        "TC authorization wiped after a base partial-collapse. Restored.",
      createdAt: iso(60 * 50),
      createdLabel: "2d ago",
      reporterId: "76561198000000011",
      subjectId: null,
      serverId: "srv1",
      assigneeId: "u_toadlord",
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000011",
          authorName: "PixelWraith",
          authorKind: "reporter",
          timestamp: hm(60 * 50),
          body: "Lost TC auth after a partial collapse \u2014 base is mine, can you re-auth me?",
        },
        {
          authorId: "u_toadlord",
          authorName: "Toadlord",
          authorKind: "staff",
          timestamp: hm(60 * 48),
          body: "Confirmed via base logs. Re-authed your TC.",
        },
      ],
    },
    {
      id: "t_4920",
      number: 4920,
      type: "general_support",
      team: "support",
      status: "closed",
      priority: "low",
      title: "Name change request \u2014 denied",
      summary:
        "Player requested a forced name change; not a supported request.",
      createdAt: iso(60 * 120),
      createdLabel: "5d ago",
      reporterId: "76561198000000023",
      subjectId: null,
      serverId: null,
      assigneeId: "u_eagle",
      restrictedRank: null,
      messages: [
        {
          authorId: "76561198000000023",
          authorName: "ZeroPing",
          authorKind: "reporter",
          timestamp: hm(60 * 120),
          body: "Can you change my display name in-game? Tired of this one.",
        },
        {
          authorId: "u_eagle",
          authorName: "Eagle",
          authorKind: "staff",
          timestamp: hm(60 * 110),
          body: "Name changes are tied to your Steam profile \u2014 we can't override that. Closing.",
        },
      ],
    },
  ];
  TICKETS.push(...moreTickets);
  const srv1 = SERVERS.find((s) => s.id === "srv1");
  const srv2 = SERVERS.find((s) => s.id === "srv2");
  const srv3 = SERVERS.find((s) => s.id === "srv3");
  srv1?.playerIds.push(
    "76561198000000011",
    "76561198000000018",
    "76561198000000022",
  );
  srv2?.playerIds.push(
    "76561198000000014",
    "76561198000000015",
    "76561198000000021",
    "76561198000000025",
  );
  srv3?.playerIds.push(
    "76561198000000012",
    "76561198000000016",
    "76561198000000019",
  );
})();
const TICKET_TYPE_LABEL = {
  player_report: "Player Report",
  ban_appeal: "Ban Appeal",
  vip_issue: "VIP Issue",
  general_support: "General Support",
};
const STATUS_LABEL = {
  open: "Active",
  triage: "Active",
  in_progress: "Active",
  waiting_response: "Waiting",
  resolved: "Closed",
  closed: "Closed",
  cleared: "Cleared",
  banned: "Banned",
};
const fmtNum = (n) => n.toLocaleString("en-US");
const BAN_LENGTH_MINUTES = {
  "1h": 60,
  "3h": 180,
  "6h": 360,
  "12h": 720,
  "24h": 1440,
  "2d": 2880,
  "3d": 4320,
  "4d": 5760,
  "5d": 7200,
  "6d": 8640,
  next_wipe: 60 * 24 * 5,
  "7d": 10080,
  "14d": 20160,
  "30d": 43200,
  permanent: null,
};
const NOW_REF = Date.parse("2026-05-26T12:00:00Z");
function _seed(s) {
  let x = s | 0;
  return () => {
    x = (x * 1664525 + 1013904223) | 0;
    return ((x >>> 0) % 1e6) / 1e6;
  };
}
function _isoAgo(mins) {
  return new Date(NOW_REF - mins * 6e4).toISOString();
}
const BAN_REASONS_BY_TYPE = {
  cheating: ["Aimbot", "ESP / Wallhack", "Scripts / Macros", "Closet cheating"],
  teaming: ["Group size violation", "Cross-team coordination", "Trade-killing"],
  toxicity: ["Slurs / Hate speech", "Harassment", "Threats / Doxxing"],
};
const MUTE_REASONS_BY_TYPE = {
  toxicity: ["Slurs / Hate speech", "Hate speech in voice"],
  spam: ["Voice spam", "Chat spam", "Soundboard spam"],
  harassment: ["Targeted harassment", "Stream sniping abuse"],
  mic_abuse: ["Mic abuse", "Earrape", "Open mic music"],
};
const LENGTH_POOL = [
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "2d",
  "3d",
  "5d",
  "7d",
  "14d",
  "30d",
  "permanent",
];
function _buildBans() {
  const r = _seed(20260526);
  const allPlayers = Object.values(PLAYERS);
  const out = [];
  for (let i = 0; i < 64; i++) {
    const subject = allPlayers[Math.floor(r() * allPlayers.length)];
    const staff = STAFF[Math.floor(r() * STAFF.length)];
    const server = SERVERS[Math.floor(r() * SERVERS.length)];
    const types = ["cheating", "teaming", "toxicity"];
    const type = types[Math.floor(r() * types.length)];
    const reason =
      BAN_REASONS_BY_TYPE[type][
        Math.floor(r() * BAN_REASONS_BY_TYPE[type].length)
      ];
    const length = LENGTH_POOL[Math.floor(r() * LENGTH_POOL.length)];
    const issuedMinsAgo = Math.floor(r() * 60 * 24 * 45);
    const issuedAt = _isoAgo(issuedMinsAgo);
    const durMin = BAN_LENGTH_MINUTES[length];
    const expiresAt =
      durMin == null
        ? null
        : new Date(NOW_REF - issuedMinsAgo * 6e4 + durMin * 6e4).toISOString();
    out.push({
      id: `b_${i + 1e3}`,
      subjectSteamId: subject.steamId,
      subjectName: subject.name,
      staffId: staff.id,
      orgId: server.orgId,
      serverId: server.id,
      type,
      reason,
      length,
      issuedAt,
      expiresAt,
      note: `Ban issued for ${type}.

Evidence: https://medal.tv/clip/${i}
Reviewed by: ${staff.name}`,
      revoked: r() < 0.06,
    });
  }
  return out.sort((a, b) => +new Date(b.issuedAt) - +new Date(a.issuedAt));
}
const BAN_RECORDS = _buildBans();
export {
  BAN_LENGTH_MINUTES,
  BAN_RECORDS,
  OWNER_STEAM_ID,
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABEL,
  SERVERS,
  STAFF,
  STATUS_LABEL,
  TEAM_IDS,
  TEAM_META,
  TICKETS,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  fmtNum,
  getPlayer,
  getPreviousTeammates,
  getServerPlayers,
  getTeammates,
};
