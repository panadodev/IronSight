import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
  Shield,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export const Route = createFileRoute("/sys-linked-accounts")({
  head: () => ({
    meta: [{ title: "Linked Accounts — IronSight Sysadmin" }],
  }),
  component: SysLinkedAccountsPage,
});

function SysLinkedAccountsPage() {
  const { sessionUser } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const [expandedUserId, setExpandedUserId] = useState(null);

  const isSysAdmin = Boolean(sessionUser?.isSysAdmin);

  useEffect(() => {
    if (sessionUser !== null && !isSysAdmin) {
      navigate({ to: "/" });
    }
  }, [sessionUser, isSysAdmin, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/sys/linked-accounts?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
      setLimit(data.limit ?? 50);
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    if (!isSysAdmin) return;
    load();
  }, [load, isSysAdmin]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  };

  const handleDelete = async (linkId, username) => {
    if (
      !window.confirm(
        `Remove this Steam account link from ${username}? This cannot be undone.`,
      )
    )
      return;
    setDeletingId(linkId);
    try {
      const res = await fetch(`/api/sys/linked-accounts/${linkId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) await load();
    } finally {
      setDeletingId(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  if (sessionUser === null) return null;

  if (!isSysAdmin) {
    return (
      <div className="h-screen flex flex-col bg-background text-foreground">
        <SiteNav />
        <main className="flex-1 grid place-items-center">
          <div className="text-center space-y-2">
            <Shield className="size-8 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Sysadmin access required.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl mx-auto space-y-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-lg font-semibold">Linked Accounts</h1>
              <p className="text-xs text-muted-foreground">
                All users with Steam accounts linked. Sysadmin only.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={load}
              disabled={loading}
            >
              <RefreshCw
                className={"size-3.5 mr-1.5 " + (loading ? "animate-spin" : "")}
              />
              Refresh
            </Button>
          </div>

          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="Search by username, Discord ID, or Steam ID…"
                className="pl-8 text-xs"
              />
            </div>
            <Button type="submit" size="sm" variant="outline">
              Search
            </Button>
            {query && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraftQuery("");
                  setQuery("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            )}
          </form>

          <div className="text-xs text-muted-foreground">
            {total} user{total !== 1 ? "s" : ""} found
            {totalPages > 1 && ` · page ${page} of ${totalPages}`}
          </div>

          {loading && users.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : users.length === 0 ? (
            <div className="ring-1 ring-border rounded-md bg-surface/40 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No linked accounts found.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {users.map((u) => {
                const isExpanded = expandedUserId === u.userId;
                return (
                  <div
                    key={u.userId}
                    className="ring-1 ring-border rounded-md bg-surface/40 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedUserId(isExpanded ? null : u.userId)
                      }
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface/60 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="size-8 rounded-md bg-muted/40 ring-1 ring-border grid place-items-center font-mono font-bold text-xs text-muted-foreground shrink-0">
                          {(u.username ?? "??").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {u.username}
                          </div>
                          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                            {u.discordId && <span>{u.discordId}</span>}
                          </div>
                        </div>
                        {u.accountCount > 1 && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded ring-1 bg-warning/10 text-warning ring-warning/30">
                            <AlertTriangle className="size-2.5" />
                            {u.accountCount} Steam accounts
                          </span>
                        )}
                      </div>
                      <ChevronRight
                        className={
                          "size-4 text-muted-foreground transition-transform shrink-0 " +
                          (isExpanded ? "rotate-90" : "")
                        }
                      />
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border px-4 pb-4 pt-3 space-y-2">
                        <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          Steam accounts
                        </p>
                        {u.steamAccounts.map((acct) => (
                          <div
                            key={acct.linkId}
                            className="flex items-center justify-between bg-background ring-1 ring-border rounded-md px-3 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {acct.isPrimary && (
                                <span className="shrink-0 text-[9px] font-mono px-1 py-0.5 rounded bg-brand/15 text-brand ring-1 ring-brand/30">
                                  PRIMARY
                                </span>
                              )}
                              <div className="min-w-0">
                                <div className="text-xs font-medium truncate">
                                  {acct.steamName ?? acct.steamId}
                                </div>
                                <div className="text-[10px] font-mono text-muted-foreground truncate">
                                  {acct.steamId}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 ml-3">
                              <a
                                href={`https://steamcommunity.com/profiles/${acct.steamId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                                title="View on Steam"
                              >
                                <ExternalLink className="size-3.5" />
                              </a>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7 text-destructive hover:text-destructive"
                                disabled={deletingId === acct.linkId}
                                onClick={() =>
                                  handleDelete(acct.linkId, u.username)
                                }
                                title="Delete link"
                              >
                                {deletingId === acct.linkId ? (
                                  <RefreshCw className="size-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="size-3.5" />
                                )}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="size-3.5 mr-1" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="size-3.5 ml-1" />
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
