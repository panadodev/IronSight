import { GateRank, SectionHeader } from "@/components/manage-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { useManageOrgId } from "@/lib/manage-org-store";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

const Route = createFileRoute("/manage/tickets")({
  component: TicketsPage,
});

const QUESTION_TYPE_LABELS = {
  text: "Text",
  number: "Number",
  multiple_choice: "Multiple Choice",
};

function QuestionForm({ orgId, ticketTypeId, question, onSave, onCancel }) {
  const [questionText, setQuestionText] = useState(
    question?.questionText ?? "",
  );
  const [questionType, setQuestionType] = useState(
    question?.questionType ?? "text",
  );
  const [isRequired, setIsRequired] = useState(question?.isRequired ?? true);
  const [minLength, setMinLength] = useState(
    question?.config?.minLength != null
      ? String(question.config.minLength)
      : "",
  );
  const [maxLength, setMaxLength] = useState(
    question?.config?.maxLength != null
      ? String(question.config.maxLength)
      : "",
  );
  const [minNum, setMinNum] = useState(
    question?.config?.min != null ? String(question.config.min) : "",
  );
  const [maxNum, setMaxNum] = useState(
    question?.config?.max != null ? String(question.config.max) : "",
  );
  const [options, setOptions] = useState(question?.config?.options ?? []);
  const [newOption, setNewOption] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const buildConfig = () => {
    if (questionType === "text") {
      return {
        ...(minLength !== "" ? { minLength: Number(minLength) } : {}),
        ...(maxLength !== "" ? { maxLength: Number(maxLength) } : {}),
      };
    }
    if (questionType === "number") {
      return {
        ...(minNum !== "" ? { min: Number(minNum) } : {}),
        ...(maxNum !== "" ? { max: Number(maxNum) } : {}),
      };
    }
    if (questionType === "multiple_choice") {
      return { options };
    }
    return {};
  };

  const addOption = () => {
    const t = newOption.trim();
    if (!t || options.includes(t)) return;
    setOptions((prev) => [...prev, t]);
    setNewOption("");
  };

  const removeOption = (i) =>
    setOptions((prev) => prev.filter((_, j) => j !== i));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      questionText,
      questionType,
      isRequired,
      config: buildConfig(),
    };

    const base = `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}/questions`;
    const url = question ? `${base}/${question.questionId}` : base;
    const method = question ? "PATCH" : "POST";

    try {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save question");
        setSaving(false);
        return;
      }
      onSave(question ? { ...question, ...payload } : data.question);
    } catch {
      setError("Network error");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md ring-1 ring-border bg-surface/60 p-4 space-y-4">
      <div className="space-y-1.5">
        <Label>Question</Label>
        <Input
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
          placeholder="e.g. Why do you want to join staff?"
          maxLength={500}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Answer Type</Label>
          <Select value={questionType} onValueChange={setQuestionType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="number">Number</SelectItem>
              <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Required</Label>
          <div className="flex items-center h-9">
            <Switch checked={isRequired} onCheckedChange={setIsRequired} />
            <span className="ml-2 text-sm text-muted-foreground">
              {isRequired ? "Yes" : "No"}
            </span>
          </div>
        </div>
      </div>

      {questionType === "text" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>
              Min length{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              type="number"
              min={0}
              value={minLength}
              onChange={(e) => setMinLength(e.target.value)}
              placeholder="e.g. 50"
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Max length{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              type="number"
              min={1}
              value={maxLength}
              onChange={(e) => setMaxLength(e.target.value)}
              placeholder="e.g. 1000"
            />
          </div>
        </div>
      )}

      {questionType === "number" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>
              Min value{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              type="number"
              value={minNum}
              onChange={(e) => setMinNum(e.target.value)}
              placeholder="e.g. 1"
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Max value{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              type="number"
              value={maxNum}
              onChange={(e) => setMaxNum(e.target.value)}
              placeholder="e.g. 100"
            />
          </div>
        </div>
      )}

      {questionType === "multiple_choice" && (
        <div className="space-y-2">
          <Label>Options</Label>
          {options.length > 0 && (
            <div className="space-y-1">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex-1 text-sm px-2 py-1 rounded bg-muted/50">
                    {opt}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeOption(i)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              placeholder="Add an option…"
              onKeyDown={(e) =>
                e.key === "Enter" && (e.preventDefault(), addOption())
              }
            />
            <Button
              variant="outline"
              size="sm"
              onClick={addOption}
              disabled={!newOption.trim()}
            >
              Add
            </Button>
          </div>
          {options.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Add at least one option.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={
            saving ||
            !questionText.trim() ||
            (questionType === "multiple_choice" && options.length === 0)
          }
        >
          {saving ? "Saving…" : question ? "Save" : "Add Question"}
        </Button>
      </div>
    </div>
  );
}

function ApplicationQuestions({ orgId, ticketTypeId }) {
  const [questions, setQuestions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [reordering, setReordering] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}/questions`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setQuestions(data?.questions ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, ticketTypeId]);

  const handleSaveNew = (q) => {
    setQuestions((prev) => [...(prev ?? []), q]);
    setAddingNew(false);
  };

  const handleSaveEdit = (updated) => {
    setQuestions((prev) =>
      prev.map((q) => (q.questionId === updated.questionId ? updated : q)),
    );
    setEditingId(null);
  };

  const handleDelete = async (questionId) => {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}/questions/${questionId}`,
      { method: "DELETE", credentials: "include" },
    );
    if (res.ok) {
      setQuestions((prev) => prev.filter((q) => q.questionId !== questionId));
    }
  };

  const handleReorder = async (questionId, direction) => {
    setReordering(questionId);
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}/questions/${questionId}/reorder`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction }),
      },
    );
    if (res.ok) {
      // Re-fetch to get updated order
      const data = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}/questions`,
        { credentials: "include" },
      ).then((r) => (r.ok ? r.json() : null));
      if (data) setQuestions(data.questions);
    }
    setReordering(null);
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground px-1">Loading questions…</p>
    );
  }

  return (
    <div className="mt-3 space-y-2 pl-1">
      {questions && questions.length > 0 && (
        <div className="space-y-2">
          {questions.map((q, i) =>
            editingId === q.questionId ? (
              <QuestionForm
                key={q.questionId}
                orgId={orgId}
                ticketTypeId={ticketTypeId}
                question={q}
                onSave={handleSaveEdit}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div
                key={q.questionId}
                className="flex items-start gap-2 rounded-md ring-1 ring-border bg-surface/40 px-3 py-2.5"
              >
                <div className="flex flex-col gap-0.5 mr-1">
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={i === 0 || reordering === q.questionId}
                    onClick={() => handleReorder(q.questionId, "up")}
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={
                      i === questions.length - 1 || reordering === q.questionId
                    }
                    onClick={() => handleReorder(q.questionId, "down")}
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug">
                    {q.questionText}
                    {!q.isRequired && (
                      <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                        (optional)
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {QUESTION_TYPE_LABELS[q.questionType]}
                    {q.questionType === "text" &&
                      (q.config?.minLength != null ||
                        q.config?.maxLength != null) && (
                        <span>
                          {" · "}
                          {q.config.minLength != null
                            ? `min ${q.config.minLength}`
                            : ""}
                          {q.config.minLength != null &&
                          q.config.maxLength != null
                            ? " – "
                            : ""}
                          {q.config.maxLength != null
                            ? `max ${q.config.maxLength} chars`
                            : ""}
                        </span>
                      )}
                    {q.questionType === "number" &&
                      (q.config?.min != null || q.config?.max != null) && (
                        <span>
                          {" · "}
                          {q.config.min != null ? `min ${q.config.min}` : ""}
                          {q.config.min != null && q.config.max != null
                            ? " – "
                            : ""}
                          {q.config.max != null ? `max ${q.config.max}` : ""}
                        </span>
                      )}
                    {q.questionType === "multiple_choice" &&
                      Array.isArray(q.config?.options) && (
                        <span>
                          {" · "}
                          {q.config.options.join(", ")}
                        </span>
                      )}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    onClick={() => setEditingId(q.questionId)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete question?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove this question from the
                          Staff Application form.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => handleDelete(q.questionId)}
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {questions?.length === 0 && !addingNew && (
        <p className="text-sm text-muted-foreground">
          No questions yet. Add one below.
        </p>
      )}

      {addingNew ? (
        <QuestionForm
          orgId={orgId}
          ticketTypeId={ticketTypeId}
          onSave={handleSaveNew}
          onCancel={() => setAddingNew(false)}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddingNew(true)}
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          Add Question
        </Button>
      )}
    </div>
  );
}

const OPEN_LIMIT_OPTIONS = [
  { value: "unlimited", label: "No limit" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
];

// How many tickets of this type a single user may have open at once.
function OpenLimitSelect({ ticketType, disabled, onChange }) {
  const current =
    ticketType.maxOpenPerUser != null
      ? String(ticketType.maxOpenPerUser)
      : "unlimited";
  // Keep a custom value (set via API) selectable even if it's not a preset.
  const options = OPEN_LIMIT_OPTIONS.some((o) => o.value === current)
    ? OPEN_LIMIT_OPTIONS
    : [...OPEN_LIMIT_OPTIONS, { value: current, label: current }];
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Open limit</span>
      <Select
        value={current}
        disabled={disabled}
        onValueChange={(v) => onChange(v === "unlimited" ? null : Number(v))}
      >
        <SelectTrigger className="h-7 w-[100px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TicketsPage() {
  const { sessionUser, hasOrgPermission } = useAuth();
  const orgId = useManageOrgId();
  const [ticketTypes, setTicketTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/ticket-types`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setTicketTypes(data?.ticketTypes ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [orgId]);

  if (!orgId) return null;

  const canManage =
    Boolean(sessionUser?.isSysAdmin) ||
    hasOrgPermission(orgId, "ticket_types_manage");

  const handleToggle = async (ticketTypeId, value) => {
    setTicketTypes((prev) =>
      prev.map((tt) =>
        tt.ticketTypeId === ticketTypeId ? { ...tt, isEnabled: value } : tt,
      ),
    );

    setUpdating(ticketTypeId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isEnabled: value }),
        },
      );

      if (!res.ok) {
        setTicketTypes((prev) =>
          prev.map((tt) =>
            tt.ticketTypeId === ticketTypeId
              ? { ...tt, isEnabled: !value }
              : tt,
          ),
        );
      }
    } catch {
      setTicketTypes((prev) =>
        prev.map((tt) =>
          tt.ticketTypeId === ticketTypeId ? { ...tt, isEnabled: !value } : tt,
        ),
      );
    }
    setUpdating(null);
  };

  const handleToggleMedia = async (ticketTypeId, value) => {
    setTicketTypes((prev) =>
      prev.map((tt) =>
        tt.ticketTypeId === ticketTypeId ? { ...tt, allowMedia: value } : tt,
      ),
    );

    setUpdating(ticketTypeId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowMedia: value }),
        },
      );

      if (!res.ok) {
        setTicketTypes((prev) =>
          prev.map((tt) =>
            tt.ticketTypeId === ticketTypeId
              ? { ...tt, allowMedia: !value }
              : tt,
          ),
        );
      }
    } catch {
      setTicketTypes((prev) =>
        prev.map((tt) =>
          tt.ticketTypeId === ticketTypeId ? { ...tt, allowMedia: !value } : tt,
        ),
      );
    }
    setUpdating(null);
  };

  const handleLimitChange = async (ticketTypeId, value) => {
    const prevValue = ticketTypes.find(
      (tt) => tt.ticketTypeId === ticketTypeId,
    )?.maxOpenPerUser;
    setTicketTypes((prev) =>
      prev.map((tt) =>
        tt.ticketTypeId === ticketTypeId
          ? { ...tt, maxOpenPerUser: value }
          : tt,
      ),
    );

    setUpdating(ticketTypeId);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/ticket-types/${ticketTypeId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxOpenPerUser: value }),
        },
      );

      if (!res.ok) {
        setTicketTypes((prev) =>
          prev.map((tt) =>
            tt.ticketTypeId === ticketTypeId
              ? { ...tt, maxOpenPerUser: prevValue }
              : tt,
          ),
        );
      }
    } catch {
      setTicketTypes((prev) =>
        prev.map((tt) =>
          tt.ticketTypeId === ticketTypeId
            ? { ...tt, maxOpenPerUser: prevValue }
            : tt,
        ),
      );
    }
    setUpdating(null);
  };

  const regularTypes = ticketTypes.filter(
    (tt) => tt.category !== "staff_application",
  );
  const applicationTypes = ticketTypes.filter(
    (tt) => tt.category === "staff_application",
  );

  return (
    <GateRank rank={canManage ? 4 : 0} required={4}>
      <SectionHeader
        title="Tickets"
        blurb="Enable or disable each ticket type and configure its custom questions."
      />
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : ticketTypes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ticket types found.</p>
      ) : (
        <div className="space-y-6">
          {regularTypes.length > 0 && (
            <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-2">
              <div className="divide-y divide-border">
                {regularTypes.map((tt) => (
                  <div key={tt.ticketTypeId} className="py-2">
                    <div className="flex items-center justify-between">
                      <button
                        className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground/80"
                        onClick={() =>
                          setExpandedId(
                            expandedId === tt.ticketTypeId
                              ? null
                              : tt.ticketTypeId,
                          )
                        }
                      >
                        {expandedId === tt.ticketTypeId ? (
                          <ChevronDown className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                        {tt.name}
                      </button>
                      <div className="flex items-center gap-4">
                        <OpenLimitSelect
                          ticketType={tt}
                          disabled={updating === tt.ticketTypeId}
                          onChange={(v) =>
                            handleLimitChange(tt.ticketTypeId, v)
                          }
                        />
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">
                            Media
                          </span>
                          <Switch
                            checked={tt.allowMedia !== false}
                            disabled={updating === tt.ticketTypeId}
                            onCheckedChange={(v) =>
                              handleToggleMedia(tt.ticketTypeId, v)
                            }
                          />
                        </div>
                        <Switch
                          checked={tt.isEnabled}
                          disabled={updating === tt.ticketTypeId}
                          onCheckedChange={(v) =>
                            handleToggle(tt.ticketTypeId, v)
                          }
                        />
                      </div>
                    </div>
                    {expandedId === tt.ticketTypeId && (
                      <ApplicationQuestions
                        orgId={orgId}
                        ticketTypeId={tt.ticketTypeId}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {applicationTypes.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Staff Applications
              </h2>
              <div className="rounded-md ring-1 ring-border bg-surface/40 p-3 space-y-3">
                {applicationTypes.map((tt) => (
                  <div key={tt.ticketTypeId}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground/80"
                          onClick={() =>
                            setExpandedId(
                              expandedId === tt.ticketTypeId
                                ? null
                                : tt.ticketTypeId,
                            )
                          }
                        >
                          {expandedId === tt.ticketTypeId ? (
                            <ChevronDown className="size-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          )}
                          {tt.name}
                        </button>
                        <span className="text-xs text-muted-foreground">
                          Configure Questions
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <OpenLimitSelect
                          ticketType={tt}
                          disabled={updating === tt.ticketTypeId}
                          onChange={(v) =>
                            handleLimitChange(tt.ticketTypeId, v)
                          }
                        />
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">
                            Media
                          </span>
                          <Switch
                            checked={tt.allowMedia !== false}
                            disabled={updating === tt.ticketTypeId}
                            onCheckedChange={(v) =>
                              handleToggleMedia(tt.ticketTypeId, v)
                            }
                          />
                        </div>
                        <Switch
                          checked={tt.isEnabled}
                          disabled={updating === tt.ticketTypeId}
                          onCheckedChange={(v) =>
                            handleToggle(tt.ticketTypeId, v)
                          }
                        />
                      </div>
                    </div>

                    {expandedId === tt.ticketTypeId && (
                      <ApplicationQuestions
                        orgId={orgId}
                        ticketTypeId={tt.ticketTypeId}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </GateRank>
  );
}

export { Route };
