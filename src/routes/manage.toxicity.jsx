import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { ToxicityPanel } from "@/components/manage-org-dialog";
import { SectionHeader, GateRank } from "@/components/manage-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Upload, X } from "lucide-react";

const Route = createFileRoute("/manage/toxicity")({
  component: ToxicityPage,
});

function ToxicityPage() {
  const { sessionUser, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();
  const [config, setConfig] = useState({ yellow: [], red: [] });
  const [words, setWords] = useState([]);
  const [wordsLoading, setWordsLoading] = useState(false);
  const [wordInput, setWordInput] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const isAdmin =
    Boolean(sessionUser?.isSysAdmin) || hasOrgPermission(orgId, "toxicity_manage");

  const fetchWords = useCallback(async () => {
    if (!orgId) return;
    setWordsLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/blacklisted-words`);
      if (res.ok) {
        const data = await res.json();
        setWords(data.words ?? []);
      }
    } catch {
      // ignore
    } finally {
      setWordsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchWords();
  }, [fetchWords]);

  const addWord = async () => {
    const trimmed = wordInput.trim().toLowerCase();
    if (!trimmed || !orgId) return;
    try {
      const res = await fetch(`/api/orgs/${orgId}/blacklisted-words`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: trimmed }),
      });
      if (res.ok) {
        const newWord = await res.json();
        setWords((prev) => [
          ...prev.filter((w) => w.word_id !== newWord.word_id),
          newWord,
        ]);
        setWordInput("");
      }
    } catch {
      // ignore
    }
  };

  const deleteWord = async (wordId) => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${orgId}/blacklisted-words/${wordId}`,
        { method: "DELETE" },
      );
      if (res.ok) setWords((prev) => prev.filter((w) => w.word_id !== wordId));
    } catch {
      // ignore
    }
  };

  const importWords = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !orgId) return;
    e.target.value = "";
    const text = await file.text();
    const existing = new Set(words.map((w) => w.word));
    const toAdd = [
      ...new Set(
        text
          .split(/[\n,]+/)
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w && w.length <= 100 && !existing.has(w)),
      ),
    ];
    if (!toAdd.length) return;
    setImporting(true);
    try {
      const results = await Promise.all(
        toAdd.map((word) =>
          fetch(`/api/orgs/${orgId}/blacklisted-words`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ word }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      const added = results.filter(Boolean);
      if (added.length) {
        setWords((prev) => {
          const seen = new Set(prev.map((w) => w.word_id));
          return [...prev, ...added.filter((w) => !seen.has(w.word_id))];
        });
      }
    } finally {
      setImporting(false);
    }
  };

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/toxicity`,
        { credentials: "include" },
      );
      if (res.ok) {
        const body = await res.json();
        setConfig({ yellow: body.yellow ?? [], red: body.red ?? [] });
      }
    } catch {
      /* ignore */
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSave = async (kind, phrases) => {
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/toxicity`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, phrases }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error ?? "Failed to save." };
    setConfig({ yellow: body.yellow ?? [], red: body.red ?? [] });
    return { ok: true };
  };

  if (!orgId) return null;

  return (
    <GateRank rank={isAdmin ? 4 : 0} required={4}>
      <SectionHeader
        title="Toxicity"
        blurb="Flag chat phrases as yellow or red in toxicity reports."
      />
      <ToxicityPanel orgId={orgId} config={config} onSave={onSave} />
      <section className="rounded-md ring-1 ring-border bg-surface/40">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Blocked Words</h2>
          <p className="text-[11px] text-muted-foreground">
            Players will not be able to send messages containing these words.
            Requires plugin restart or just server daily restart.
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Input
              value={wordInput}
              onChange={(e) => setWordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addWord();
                }
              }}
              placeholder="Add a word..."
              className="h-8 text-sm max-w-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={addWord}
              disabled={!wordInput.trim()}
            >
              <Plus className="size-3.5" /> Add
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,.text,text/plain,text/csv"
              className="hidden"
              onChange={importWords}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-3.5" />
              {importing ? "Importing…" : "Import file"}
            </Button>
          </div>
          {wordsLoading ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : words.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No blocked words configured.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {words.map((w) => (
                <span
                  key={w.word_id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface ring-1 ring-border text-xs font-mono"
                >
                  {w.word}
                  <button
                    onClick={() => deleteWord(w.word_id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </GateRank>
  );
}

export { Route };
