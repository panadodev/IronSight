import { useMemo, useState } from "react";

function bmBanStatusLabel(ban) {
  if (ban.permanent || !ban.expiresAt)
    return { label: "Permanent", tone: "danger" };
  const sec = ban.expiresAt - Math.floor(Date.now() / 1000);
  if (sec <= 0) return { label: "Expired", tone: "muted" };
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return {
    label: days > 0 ? `Expires in ${days}d` : `Expires in ${hours}h`,
    tone: "warning",
  };
}

function bmBanWhen(bannedAt) {
  if (!bannedAt) return "—";
  const days = Math.floor((Date.now() / 1000 - bannedAt) / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function transformBmBans(rawBans) {
  return rawBans.map((b) => {
    const st = bmBanStatusLabel(b);
    return {
      id: b.bmBanId,
      orgName: b.bmOrgName ?? "Unknown Org",
      reason: b.reason ?? "—",
      by: "—",
      when: bmBanWhen(b.bannedAt),
      status: st.label,
      statusTone: st.tone,
      note: b.note ?? null,
    };
  });
}

const HTML_TAG_RE = /<[a-z][\s\S]*?>/i;

// Sanitizes BattleMetrics-sourced HTML ban notes for safe dangerouslySetInnerHTML rendering.
// Uses the browser's DOMParser so no third-party library is needed.
// Allowlist: block/inline text elements + anchors with https-only hrefs.
// Removes: script, style, iframe, svg, all on* handlers, style/class/id attributes.
function sanitizeBanNote(html) {
  if (typeof document === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");

  const BLOCKED = "script,style,iframe,object,embed,form,input,textarea,button,meta,link,svg,math,canvas,noscript";
  doc.querySelectorAll(BLOCKED).forEach((el) => el.remove());

  doc.querySelectorAll("*").forEach((el) => {
    // Strip all event handlers and style/class/id to prevent injection
    [...el.attributes].forEach((attr) => {
      if (
        attr.name.startsWith("on") ||
        attr.name === "style" ||
        attr.name === "class" ||
        attr.name === "id"
      ) {
        el.removeAttribute(attr.name);
      }
    });

    // Anchor: only allow safe absolute https URLs
    if (el.tagName === "A") {
      const href = (el.getAttribute("href") ?? "").trim();
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer nofollow");
      } else {
        // Non-http href (javascript:, data:, etc.) — drop the link, keep text
        el.replaceWith(document.createTextNode(el.textContent));
      }
    }
  });

  return doc.body.innerHTML;
}

function BanNoteContent({ note }) {
  if (!note) {
    return (
      <p className="text-xs text-muted-foreground italic">No additional notes.</p>
    );
  }

  if (HTML_TAG_RE.test(note)) {
    const safe = sanitizeBanNote(note);
    if (safe != null) {
      return (
        <div
          className={[
            "text-sm text-foreground leading-relaxed",
            "[&_p]:mb-2 [&_p:last-child]:mb-0",
            "[&_br]:block",
            "[&_a]:text-brand [&_a]:underline [&_a:hover]:opacity-75",
            "[&_strong]:font-semibold [&_em]:italic",
            "[&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-2",
            "[&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-2",
            "[&_li]:mb-0.5",
          ].join(" ")}
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      );
    }
  }

  // Plain text fallback
  return (
    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
      {note}
    </p>
  );
}

function ExternalBansSection({ bans: rawBans }) {
  const bans = useMemo(
    () => transformBmBans(Array.isArray(rawBans) ? rawBans : []),
    [rawBans],
  );
  const [openId, setOpenId] = useState(null);
  const open = bans.find((b) => b.id === openId) ?? null;
  return (
    <section className="bg-surface/60 ring-1 ring-border rounded-lg p-4">
      <h2 className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center justify-between">
        <span>
          All Bans
          <span className="ml-2 normal-case tracking-normal text-[0.625rem] text-muted-foreground/70">
            (read-only · from BattleMetrics)
          </span>
        </span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          {bans.length}
        </span>
      </h2>
      {bans.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No external bans on file.
        </p>
      ) : (
        <div className="bg-background/60 ring-1 ring-border rounded-lg overflow-hidden">
          <table className="w-full text-[0.625rem] font-mono">
            <thead>
              <tr className="text-[0.625rem] uppercase tracking-wider text-muted-foreground bg-surface/60">
                <th className="px-1.5 py-1 text-left font-medium">Org</th>
                <th className="px-1.5 py-1 text-left font-medium">Status</th>
                <th className="px-1.5 py-1 text-left font-medium">Reason</th>
                <th className="px-1.5 py-1 text-left font-medium">Staff</th>
                <th className="px-1.5 py-1 text-left font-medium">Note</th>
                <th className="px-1.5 py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {bans.map((b) => {
                const statusColor =
                  b.statusTone === "danger"
                    ? "text-danger"
                    : b.statusTone === "warning"
                      ? "text-warning"
                      : "text-muted-foreground";
                return (
                  <tr key={b.id} className="border-t border-border">
                    <td
                      className="px-1.5 py-1 text-foreground font-semibold"
                      title={b.orgName}
                    >
                      {b.orgName}
                    </td>
                    <td className={`px-1.5 py-1 ${statusColor}`}>{b.status}</td>
                    <td className="px-1.5 py-1 text-foreground">{b.reason}</td>
                    <td className="px-1.5 py-1 text-muted-foreground">
                      {b.by}
                    </td>
                    <td className="px-1.5 py-1">
                      <button
                        onClick={() => setOpenId(b.id)}
                        className="text-brand hover:underline"
                      >
                        view
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-right text-muted-foreground">
                      {b.when}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onClick={() => setOpenId(null)}
        >
          <div
            className="bg-background ring-1 ring-border rounded-lg p-5 max-w-md w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                <span className="text-danger">Ban</span> · {open.reason}
              </h3>
              <button
                onClick={() => setOpenId(null)}
                className="text-[0.625rem] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                close
              </button>
            </div>
            <p className="text-[0.625rem] font-mono text-muted-foreground uppercase mb-3">
              {open.orgName} · by {open.by} · {open.when} · {open.status}
            </p>
            <BanNoteContent note={open.note} />
            <p className="mt-4 text-[0.625rem] font-mono text-muted-foreground uppercase tracking-wider border-t border-border pt-3">
              Read-only · shared from {open.orgName}'s banlist. Cannot be edited
              or removed here.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export { ExternalBansSection };
