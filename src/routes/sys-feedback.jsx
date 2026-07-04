import { SiteNav } from "@/components/site-nav";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

export const Route = createFileRoute("/sys-feedback")({
  head: () => ({ meta: [{ title: "Ticket Feedback — IronSight Sysadmin" }] }),
  component: SysFeedbackPage,
});

function StarDisplay({ rating }) {
  return (
    <span className="text-sm leading-none">
      {[1, 2, 3, 4, 5].map((s) => (
        <span key={s} className={s <= rating ? "text-amber-400" : "text-border"}>
          ★
        </span>
      ))}
    </span>
  );
}

function fmtDate(unix) {
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function SysFeedbackPage() {
  const { sessionUser } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (sessionUser && !sessionUser.isSysAdmin) {
      navigate({ to: "/" });
    }
  }, [sessionUser, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sys/feedback?page=${page}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(await res.json());
      setError("");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  if (!sessionUser) return null;
  if (!sessionUser.isSysAdmin) return null;

  const feedback = data?.feedback ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const avgRating =
    feedback.length > 0
      ? (feedback.reduce((s, f) => s + f.rating, 0) / feedback.length).toFixed(
          1,
        )
      : null;

  const ratingCounts = [1, 2, 3, 4, 5].map((r) => ({
    rating: r,
    count: feedback.filter((f) => f.rating === r).length,
  }));
  const maxCount = Math.max(...ratingCounts.map((r) => r.count), 1);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteNav />
      <div className="flex-1 max-w-[1100px] mx-auto w-full px-4 py-6 space-y-6">
        <div>
          <p className="text-[0.625rem] font-mono uppercase tracking-widest text-danger mb-1">
            Sysadmin Only
          </p>
          <h1 className="text-xl font-semibold">Ticket Feedback</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Feedback submitted by public users after creating a support ticket.
          </p>
        </div>

        {error && (
          <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {!loading && feedback.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4">
              <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                Total responses
              </p>
              <p className="text-3xl font-semibold tabular-nums">{total}</p>
            </div>
            <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4">
              <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                Average rating
              </p>
              <p className="text-3xl font-semibold tabular-nums text-amber-400">
                {avgRating} <span className="text-lg">/ 5</span>
              </p>
            </div>
          </div>
        )}

        {!loading && feedback.length > 0 && (
          <div className="rounded-lg ring-1 ring-border bg-surface/40 p-4 space-y-2">
            <p className="text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
              Rating distribution (this page)
            </p>
            {[5, 4, 3, 2, 1].map(({ rating: r, count: c }) => {
              const item = ratingCounts.find((x) => x.rating === r);
              const c2 = item?.count ?? 0;
              return (
                <div key={r} className="flex items-center gap-2">
                  <span className="text-amber-400 text-xs w-3">{r}</span>
                  <span className="text-border text-xs">★</span>
                  <div className="flex-1 h-2 bg-border/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-400/60 rounded-full transition-all"
                      style={{ width: `${(c2 / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-[0.625rem] font-mono text-muted-foreground w-5 text-right">
                    {c2}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {loading ? (
          <div className="grid place-items-center py-20">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        ) : feedback.length === 0 ? (
          <div className="rounded-lg ring-1 ring-border bg-surface/40 px-4 py-12 text-center text-sm text-muted-foreground">
            No feedback submitted yet.
          </div>
        ) : (
          <div className="rounded-md ring-1 ring-border bg-surface/40 overflow-hidden">
            <div className="grid grid-cols-[60px_100px_120px_1fr_160px] gap-3 px-4 py-2 border-b border-border bg-surface/60 text-[0.625rem] font-mono uppercase tracking-widest text-muted-foreground">
              <div>Ticket</div>
              <div>Rating</div>
              <div>Org</div>
              <div>Comment</div>
              <div className="text-right">Date</div>
            </div>
            {feedback.map((f) => (
              <div
                key={f.feedbackId}
                className="grid grid-cols-[60px_100px_120px_1fr_160px] gap-3 px-4 py-3 border-b border-border last:border-0 text-sm items-start"
              >
                <div className="font-mono text-[0.6875rem] text-brand">
                  #{f.ticketId}
                </div>
                <div>
                  <StarDisplay rating={f.rating} />
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {f.orgName}
                </div>
                <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
                  {f.comment ?? (
                    <span className="text-muted-foreground/50 italic">
                      no comment
                    </span>
                  )}
                </div>
                <div className="text-[0.625rem] font-mono text-muted-foreground text-right">
                  {fmtDate(f.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {page} of {totalPages} · {total} total
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-xs ring-1 ring-border rounded disabled:opacity-40 hover:bg-surface/60 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-xs ring-1 ring-border rounded disabled:opacity-40 hover:bg-surface/60 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
