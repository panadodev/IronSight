import { SiteNav } from "@/components/site-nav";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const PUBLIC_ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm", "mov"];
const PUBLIC_ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
]);

function formatBytes(b) {
  if (!b) return "";
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Upload a file to a presigned PUT URL with XHR for progress.
function putToPresignedUrl(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

const Route = createFileRoute("/submit")({
  validateSearch: (s) => ({
    org: typeof s.org === "string" ? s.org : void 0,
  }),
  beforeLoad: ({ search }) => {
    if (!search.org) throw redirect({ to: "/support" });
  },
  head: () => ({
    meta: [
      { title: "Submit a Ticket — IronSight Support" },
      {
        name: "description",
        content:
          "Sign in with Steam and report cheaters, appeal bans, or get support.",
      },
    ],
  }),
  component: SubmitPage,
});

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
];

function SubmitPage() {
  const { org: orgId } = Route.useSearch();
  const [session, setSession] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [org, setOrg] = useState(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [servers, setServers] = useState([]);
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [selectedServerId, setSelectedServerId] = useState(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [targetSteamId, setTargetSteamId] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerResults, setPlayerResults] = useState([]);
  const [playerSearching, setPlayerSearching] = useState(false);
  const [playerDropdownOpen, setPlayerDropdownOpen] = useState(false);
  const playerSearchRef = useRef(null);
  const [reportCategory, setReportCategory] = useState("cheating");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(null);
  // File attachments state
  const [attachments, setAttachments] = useState([]); // { file, mediaId, status, progress, error }
  const attachFileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) {
          setSession(data?.user ?? null);
          setSessionChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/orgs").then((r) => (r.ok ? r.json() : { orgs: [] })),
      fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`).then((r) =>
        r.ok ? r.json() : { ticketTypes: [] },
      ),
      fetch(`/api/orgs/${encodeURIComponent(orgId)}/public-servers`).then(
        (r) => (r.ok ? r.json() : { servers: [] }),
      ),
    ])
      .then(([orgsBody, typesBody, serversBody]) => {
        if (cancelled) return;
        const found = (orgsBody.orgs ?? []).find((o) => o.orgId === orgId);
        setOrg(found ?? null);
        setTicketTypes(typesBody.ticketTypes ?? []);
        setServers(serversBody.servers ?? []);
        setOrgLoading(false);
      })
      .catch(() => {
        if (!cancelled) setOrgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const selectedType =
    ticketTypes.find((t) => t.ticketTypeId === selectedTypeId) ?? null;
  const isPlayerReport =
    selectedType?.category === "player_single" ||
    selectedType?.category === "player_multi";
  // Teaming reports are inherently about multiple players, so allow selecting
  // several even when the ticket type itself isn't configured as player_multi.
  const isMultiPlayerReport =
    selectedType?.category === "player_multi" ||
    (isPlayerReport && reportCategory === "teaming");
  const showServerStep = isPlayerReport && servers.length > 0;

  // When the report mode flips between single and multi (e.g. choosing the
  // "Teaming" category), carry the existing selection across so it isn't lost.
  useEffect(() => {
    if (!isPlayerReport) return;
    if (isMultiPlayerReport) {
      setSelectedPlayers((cur) =>
        cur.length === 0 && selectedPlayer ? [selectedPlayer] : cur,
      );
    } else {
      setSelectedPlayer((cur) => cur ?? selectedPlayers[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiPlayerReport, isPlayerReport]);

  useEffect(() => {
    if (!isPlayerReport) return;
    const q = playerQuery.trim();
    if (q.length < 2) {
      setPlayerResults([]);
      setPlayerDropdownOpen(false);
      return;
    }
    setPlayerSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/players/search?q=${encodeURIComponent(q)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          setPlayerResults(data.players ?? []);
          setPlayerDropdownOpen(true);
        }
      } catch {}
      setPlayerSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [playerQuery, isPlayerReport, orgId]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!playerSearchRef.current?.contains(e.target))
        setPlayerDropdownOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function uploadAttachment(att, index) {
    const updateAtt = (patch) =>
      setAttachments((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));

    updateAtt({ status: "preparing" });
    try {
      // Step 1: get presigned URL.
      const prepareRes = await fetch("/api/public/ticket-media/prepare", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          filename: att.file.name,
          mimeType: att.file.type,
          fileSize: att.file.size,
        }),
      });
      const prepareBody = await prepareRes.json().catch(() => null);
      if (!prepareRes.ok) throw new Error(prepareBody?.error ?? "Failed to prepare upload");

      // Step 2: PUT file directly to R2.
      updateAtt({ status: "uploading", progress: 0 });
      await putToPresignedUrl(prepareBody.uploadUrl, att.file, (frac) => {
        updateAtt({ progress: Math.round(frac * 90) });
      });

      // Step 3: confirm.
      updateAtt({ status: "confirming", progress: 95 });
      const confirmRes = await fetch("/api/public/ticket-media/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId: prepareBody.mediaId }),
      });
      if (!confirmRes.ok) throw new Error("Failed to confirm upload");

      updateAtt({ status: "done", progress: 100, mediaId: prepareBody.mediaId });
    } catch (err) {
      updateAtt({ status: "error", error: err.message ?? "Upload failed" });
    }
  }

  function addAttachmentFiles(files) {
    const toAdd = Array.from(files)
      .filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase();
        return PUBLIC_ALLOWED_MIME.has(f.type) && PUBLIC_ALLOWED_EXTENSIONS.includes(ext);
      })
      .slice(0, 5 - attachments.length);
    const newAtts = toAdd.map((file) => ({ file, status: "pending", progress: 0, mediaId: null, error: null }));
    setAttachments((prev) => [...prev, ...newAtts]);
  }

  async function handleSubmit() {
    if (!selectedTypeId || !orgId) return;
    let ticketTitle = title.trim();
    let message = body.trim();
    const players = isMultiPlayerReport
      ? selectedPlayers
      : selectedPlayer
        ? [selectedPlayer]
        : [];
    if (isPlayerReport) {
      if (players.length === 0 || !message) return;
      const steamIds = players.map((p) => p.steamId).join(", ");
      ticketTitle = ticketTitle || `${reportCategory} — ${steamIds}`;
      const evidenceText = evidence.trim();
      if (evidenceText) message = `${message}\n\nEvidence:\n${evidenceText}`;
      const serverName = selectedServerId
        ? (servers.find((s) => s.serverId === selectedServerId)?.serverName ??
          "")
        : "";
      const prefix = [
        serverName ? `Server: ${serverName}` : null,
        isMultiPlayerReport
          ? `Target Steam IDs: ${steamIds}`
          : `Target Steam ID: ${steamIds}`,
        `Category: ${reportCategory}`,
      ]
        .filter(Boolean)
        .join("\n");
      message = `${prefix}\n\n${message}`;
    } else {
      if (!ticketTitle || !message) return;
    }
    setSubmitting(true);
    setSubmitError("");

    // Upload any pending attachments before submitting the ticket.
    const pendingIndices = attachments
      .map((a, i) => (a.status === "pending" ? i : null))
      .filter((i) => i !== null);
    if (pendingIndices.length > 0) {
      await Promise.all(pendingIndices.map((i) => uploadAttachment(attachments[i], i)));
    }

    // Re-read state after uploads complete.
    const latestAtts = await new Promise((resolve) => {
      setAttachments((prev) => { resolve(prev); return prev; });
    });
    if (latestAtts.some((a) => a.status === "error")) {
      setSubmitError("One or more attachments failed to upload. Remove them or try again.");
      setSubmitting(false);
      return;
    }
    const confirmedMediaIds = latestAtts
      .filter((a) => a.status === "done" && a.mediaId)
      .map((a) => a.mediaId);

    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          ticketTypeId: selectedTypeId,
          title: ticketTitle,
          message,
          reportedPlayers: isPlayerReport ? players.map((p) => p.steamId) : [],
          mediaIds: confirmedMediaIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data?.error ?? "Failed to submit ticket.");
        return;
      }
      setSubmitted({ ticketId: data.ticketId });
    } catch {
      setSubmitError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setSubmitted(null);
    setSelectedTypeId(null);
    setSelectedServerId(null);
    setTitle("");
    setBody("");
    setTargetSteamId("");
    setSelectedPlayer(null);
    setSelectedPlayers([]);
    setPlayerQuery("");
    setPlayerResults([]);
    setPlayerDropdownOpen(false);
    setReportCategory("cheating");
    setEvidence("");
    setSubmitError("");
    setAttachments([]);
  }

  if (!sessionChecked || orgLoading) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
        <SiteNav />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto p-8">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-6 space-y-2">
              <h1 className="text-lg font-semibold">Organization not found</h1>
              <p className="text-sm text-muted-foreground">
                The organization "{orgId}" does not exist or is unavailable.
              </p>
              <Link
                to="/support"
                className="text-sm font-semibold text-brand hover:underline"
              >
                Back to organization selection
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 text-center">
            <div className="size-12 mx-auto mb-4 bg-brand rounded-md grid place-items-center font-mono font-bold text-brand-foreground text-lg">
              R
            </div>
            <h1 className="text-xl font-semibold mb-2">Verify your identity</h1>
            <p className="text-sm text-muted-foreground mb-1">
              Filing for{" "}
              <span className="text-foreground font-semibold">{org.name}</span>.
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              Link your Discord and Steam accounts to submit a ticket.
            </p>
            <a
              href={`/support?org=${encodeURIComponent(orgId)}`}
              className="w-full py-3 bg-brand hover:opacity-90 text-brand-foreground rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-opacity"
            >
              Link accounts to continue
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-md bg-surface/60 ring-1 ring-border rounded-xl p-8 text-center">
            <div className="size-10 mx-auto mb-4 bg-success/10 ring-1 ring-success/30 rounded-full grid place-items-center text-success font-bold text-lg">
              ✓
            </div>
            <h1 className="text-xl font-semibold mb-1">Ticket submitted</h1>
            <p className="text-sm text-muted-foreground mb-2">
              Your ticket reference is{" "}
              <span className="font-mono text-brand">
                #{submitted.ticketId}
              </span>
              .
            </p>
            <p className="text-xs text-muted-foreground mb-6">
              Staff will review your ticket shortly. Track it in{" "}
              <Link
                to="/my-reports"
                search={{ org: orgId }}
                className="text-brand underline"
              >
                My Tickets
              </Link>
              .
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={resetForm}
                className="px-4 py-2 bg-surface ring-1 ring-border rounded text-xs font-semibold uppercase tracking-wider hover:bg-surface/80"
              >
                Submit another
              </button>
              <Link
                to="/my-reports"
                search={{ org: orgId }}
                className="px-4 py-2 bg-brand text-brand-foreground rounded text-xs font-semibold uppercase tracking-wider hover:opacity-90"
              >
                View my tickets
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = (() => {
    if (!selectedTypeId) return false;
    if (isPlayerReport) {
      const hasPlayers = isMultiPlayerReport
        ? selectedPlayers.length > 0
        : !!selectedPlayer;
      const hasServer = !showServerStep || !!selectedServerId;
      return hasPlayers && hasServer && body.trim().length > 0;
    }
    return title.trim().length > 0 && body.trim().length > 0;
  })();

  let step = 0;
  const nextStep = () => ++step;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-8">
          <header>
            <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
              {org.name} · Player Portal
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Submit a ticket
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-prose">
              {isPlayerReport
                ? "Reports require you to choose the server you saw the player on, then pick them from the list."
                : "Pick a ticket type and provide as much detail as possible."}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground mt-1">
              Signed in as{" "}
              <span className="text-foreground">{session.username}</span>
              {session.steamId && <> · Steam {session.steamId}</>}
            </p>
          </header>

          <section className="space-y-3">
            <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
              Ticket type
            </label>
            {ticketTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ticket types available.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {ticketTypes.map((t) => {
                  const active = selectedTypeId === t.ticketTypeId;
                  return (
                    <button
                      key={t.ticketTypeId}
                      onClick={() => {
                        setSelectedTypeId(t.ticketTypeId);
                        setSelectedServerId(null);
                        setSelectedPlayer(null);
                        setSelectedPlayers([]);
                        setPlayerQuery("");
                        setPlayerResults([]);
                      }}
                      className={
                        "text-left p-4 rounded-lg ring-1 transition-colors " +
                        (active
                          ? "bg-brand/10 ring-brand/30"
                          : "bg-surface/40 ring-border hover:bg-surface/70")
                      }
                    >
                      <div className="flex items-center justify-between mb-1">
                        <p
                          className={
                            "text-sm font-semibold " +
                            (active ? "text-brand" : "text-foreground")
                          }
                        >
                          {t.name}
                        </p>
                        {active && (
                          <span className="size-1.5 rounded-full bg-brand" />
                        )}
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        {t.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {selectedType && isPlayerReport && (
            <>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step {nextStep()} · What did they do?
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {REPORT_CATEGORIES.map((c) => {
                    const active = reportCategory === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setReportCategory(c.id)}
                        className={
                          "text-left p-3 rounded-lg ring-1 transition-colors " +
                          (active
                            ? "bg-brand/10 ring-brand/30"
                            : "bg-surface/40 ring-border hover:bg-surface/70")
                        }
                      >
                        <p
                          className={
                            "text-sm font-semibold " +
                            (active ? "text-brand" : "text-foreground")
                          }
                        >
                          {c.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {c.blurb}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>

              {showServerStep && (
                <section className="space-y-3">
                  <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                    Step {nextStep()} · Server
                  </label>
                  <div className="grid grid-cols-1 gap-2">
                    {servers.map((s) => {
                      const active = selectedServerId === s.serverId;
                      return (
                        <button
                          key={s.serverId}
                          onClick={() => setSelectedServerId(s.serverId)}
                          className={
                            "text-left px-4 py-3 rounded-lg ring-1 transition-colors flex items-center justify-between " +
                            (active
                              ? "bg-brand/10 ring-brand/30"
                              : "bg-surface/40 ring-border hover:bg-surface/70")
                          }
                        >
                          <p
                            className={
                              "text-sm font-semibold " +
                              (active ? "text-brand" : "text-foreground")
                            }
                          >
                            {s.serverName}
                          </p>
                          {active && (
                            <span className="size-1.5 rounded-full bg-brand shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step {nextStep()} · Reported player
                  {isMultiPlayerReport ? "s" : ""}
                </label>
                {isMultiPlayerReport ? (
                  <>
                    {selectedPlayers.length > 0 && (
                      <div className="flex flex-wrap gap-2 p-3 bg-surface/40 ring-1 ring-border rounded">
                        {selectedPlayers.map((player) => (
                          <div
                            key={player.steamId}
                            className="flex items-center gap-2 px-3 py-1 bg-brand/20 ring-1 ring-brand/40 rounded-full"
                          >
                            <span className="text-sm font-medium">
                              {player.name}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPlayers(
                                  selectedPlayers.filter(
                                    (p) => p.steamId !== player.steamId,
                                  ),
                                );
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div ref={playerSearchRef} className="relative">
                      <input
                        type="text"
                        value={playerQuery}
                        onChange={(e) => setPlayerQuery(e.target.value)}
                        onFocus={() =>
                          playerResults.length > 0 &&
                          setPlayerDropdownOpen(true)
                        }
                        placeholder="Add players by name or Steam ID…"
                        className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                      {playerSearching && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                          Searching…
                        </span>
                      )}
                      {playerDropdownOpen && playerResults.length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-background ring-1 ring-border rounded-md shadow-lg">
                          {playerResults.map((p) => (
                            <button
                              key={p.steamId}
                              type="button"
                              onClick={() => {
                                if (
                                  !selectedPlayers.find(
                                    (sp) => sp.steamId === p.steamId,
                                  )
                                ) {
                                  setSelectedPlayers([...selectedPlayers, p]);
                                }
                                setPlayerDropdownOpen(false);
                                setPlayerQuery("");
                                setPlayerResults([]);
                              }}
                              className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-surface/60 transition-colors border-b border-border/50 last:border-0"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{p.name}</p>
                                <p className="text-[10px] font-mono text-muted-foreground">
                                  {p.steamId}
                                </p>
                              </div>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {new Date(
                                  p.lastSeenAt * 1000,
                                ).toLocaleDateString()}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {playerQuery.trim().length >= 2 &&
                        !playerSearching &&
                        playerResults.length === 0 && (
                          <div className="absolute z-20 mt-1 w-full bg-background ring-1 ring-border rounded-md shadow-lg">
                            <div className="p-3 text-xs text-muted-foreground">
                              No players found matching "{playerQuery.trim()}".
                            </div>
                          </div>
                        )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Search by in-game name or Steam64 ID. Add as many as
                      needed.
                    </p>
                  </>
                ) : (
                  <>
                    {selectedPlayer ? (
                      <div className="flex items-center gap-3 p-3 bg-surface/40 ring-1 ring-border rounded">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {selectedPlayer.name}
                          </p>
                          <p className="text-[10px] font-mono text-muted-foreground">
                            {selectedPlayer.steamId}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPlayer(null);
                            setTargetSteamId("");
                            setPlayerQuery("");
                            setPlayerResults([]);
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground shrink-0 px-2 py-1 rounded hover:bg-surface/60 transition-colors"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div ref={playerSearchRef} className="relative">
                        <input
                          type="text"
                          value={playerQuery}
                          onChange={(e) => {
                            setPlayerQuery(e.target.value);
                            setSelectedPlayer(null);
                            setTargetSteamId("");
                          }}
                          onFocus={() =>
                            playerResults.length > 0 &&
                            setPlayerDropdownOpen(true)
                          }
                          placeholder="Type a name or Steam ID — or scroll the list…"
                          className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40"
                        />
                        {playerSearching && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                            Searching…
                          </span>
                        )}
                        {playerDropdownOpen && playerResults.length > 0 && (
                          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-background ring-1 ring-border rounded-md shadow-lg">
                            {playerResults.map((p) => (
                              <button
                                key={p.steamId}
                                type="button"
                                onClick={() => {
                                  setSelectedPlayer(p);
                                  setTargetSteamId(p.steamId);
                                  setPlayerDropdownOpen(false);
                                  setPlayerQuery("");
                                  setPlayerResults([]);
                                }}
                                className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-surface/60 transition-colors border-b border-border/50 last:border-0"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium">
                                    {p.name}
                                  </p>
                                  <p className="text-[10px] font-mono text-muted-foreground">
                                    {p.steamId}
                                  </p>
                                </div>
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  {new Date(
                                    p.lastSeenAt * 1000,
                                  ).toLocaleDateString()}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {playerQuery.trim().length >= 2 &&
                          !playerSearching &&
                          playerResults.length === 0 && (
                            <div className="absolute z-20 mt-1 w-full bg-background ring-1 ring-border rounded-md shadow-lg">
                              <div className="p-3 text-xs text-muted-foreground">
                                No players found matching "{playerQuery.trim()}
                                ".
                              </div>
                            </div>
                          )}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Search for the player by their in-game name or Steam64 ID.
                    </p>
                  </>
                )}
              </section>

              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Step {nextStep()} · Description
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Describe what you saw. Include time, server, grid coords..."
                  className="w-full h-32 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </section>

              <section className="space-y-3">
                <label className="flex items-center justify-between text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  <span>Step {nextStep()} · Evidence links</span>
                  <span className="text-muted-foreground/70 normal-case tracking-normal font-mono">
                    optional
                  </span>
                </label>
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder={"https://medal.tv/...\nhttps://youtu.be/..."}
                  className="w-full h-24 bg-background border border-border rounded p-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </section>
            </>
          )}

          {selectedType && !isPlayerReport && (
            <>
              <section className="space-y-3">
                <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary of your issue..."
                  maxLength={255}
                  className="w-full bg-background border border-border rounded px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </section>
              {title.trim() && (
                <section className="space-y-3">
                  <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                    Details
                  </label>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Provide as much detail as possible..."
                    className="w-full h-40 bg-background border border-border rounded p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                  />
                </section>
              )}
            </>
          )}

          {selectedType && session?.steamId && (
            <section className="space-y-2">
              <label className="block text-[10px] uppercase font-bold text-muted-foreground tracking-widest">
                Attachments <span className="normal-case font-normal text-muted-foreground/60">(optional — images &amp; videos only)</span>
              </label>
              {attachments.length > 0 && (
                <ul className="space-y-1.5">
                  {attachments.map((att, i) => (
                    <li key={i} className="flex items-center gap-2 bg-surface/30 rounded-md px-3 py-2 text-sm">
                      <span className="flex-1 truncate text-xs">{att.file.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{formatBytes(att.file.size)}</span>
                      {att.status === "pending" && (
                        <span className="text-[10px] text-muted-foreground">Pending</span>
                      )}
                      {(att.status === "preparing" || att.status === "uploading" || att.status === "confirming") && (
                        <span className="text-[10px] text-muted-foreground">
                          {att.status === "preparing" ? "Preparing…" : att.status === "confirming" ? "Finalizing…" : `${att.progress}%`}
                        </span>
                      )}
                      {att.status === "done" && (
                        <span className="text-[10px] text-emerald-500">✓</span>
                      )}
                      {att.status === "error" && (
                        <span className="text-[10px] text-danger truncate max-w-[120px]" title={att.error}>{att.error}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="text-muted-foreground hover:text-danger transition-colors"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attachments.length < 5 && (
                <button
                  type="button"
                  onClick={() => attachFileRef.current?.click()}
                  disabled={submitting}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors border border-dashed border-border rounded-md px-3 py-2 w-full justify-center"
                >
                  + Add file ({attachments.length}/5)
                </button>
              )}
              <input
                ref={attachFileRef}
                type="file"
                className="hidden"
                multiple
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
                onChange={(e) => { addAttachmentFiles(e.target.files); e.target.value = ""; }}
              />
              <p className="text-[10px] text-muted-foreground">
                Supported: jpg, png, gif, webp, mp4, webm, mov · Max 100 MB each · Up to 5 files · Uploaded securely to cloud storage
              </p>
            </section>
          )}

          {selectedType && (
            <div className="flex flex-col items-center gap-3 pt-2">
              {submitError && (
                <p className="text-sm text-danger">{submitError}</p>
              )}
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="px-8 py-3 bg-brand text-brand-foreground text-sm font-semibold rounded-md ring-1 ring-brand hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {submitting ? "Submitting…" : "Submit ticket"}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export { Route };
