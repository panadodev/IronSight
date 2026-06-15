import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import {
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

function redirectToLogin() {
  window.location.assign(
    `/login?next=${encodeURIComponent(window.location.pathname)}`,
  );
}

function authFetch(url, init) {
  return fetch(url, init).then((res) => {
    if (res.status === 401) {
      redirectToLogin();
      const err = new Error("Session expired");
      err.code = "AUTH_EXPIRED";
      throw err;
    }
    return res;
  });
}

function isAuthExpired(err) {
  return err?.code === "AUTH_EXPIRED";
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/todo")({
  head: () => ({ meta: [{ title: "Todo - IronSight" }] }),
  component: TodoPage,
});

const STATUS_META = {
  todo: {
    label: "Todo",
    card: "bg-yellow-500/10 ring-yellow-500/30 hover:bg-yellow-500/15",
    badge: "border-yellow-500/40 text-yellow-400 bg-yellow-500/10",
  },
  in_progress: {
    label: "In Progress",
    card: "bg-orange-500/10 ring-orange-500/30 hover:bg-orange-500/15",
    badge: "border-orange-500/40 text-orange-400 bg-orange-500/10",
  },
  blocked: {
    label: "Blocked",
    card: "bg-blue-500/10 ring-blue-500/30 hover:bg-blue-500/15",
    badge: "border-blue-500/40 text-blue-400 bg-blue-500/10",
  },
  completed: {
    label: "Completed",
    card: "bg-emerald-500/10 ring-emerald-500/30 hover:bg-emerald-500/15",
    badge: "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
  },
};

function metaFor(status) {
  return STATUS_META[status] ?? STATUS_META.todo;
}

function fmtDate(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TodoPage() {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [todos, setTodos] = useState([]);
  const [boardOrgIds, setBoardOrgIds] = useState([]);
  const [boardStaff, setBoardStaff] = useState([]);
  const [view, setView] = useState("board");
  const [completedSearch, setCompletedSearch] = useState("");
  const [draggedTodo, setDraggedTodo] = useState(null);
  const [dragOverStaff, setDragOverStaff] = useState(null);

  // Create task dialog
  const [createTaskStaff, setCreateTaskStaff] = useState(null);
  const [createTaskOrgId, setCreateTaskOrgId] = useState("");
  const [createTaskTitle, setCreateTaskTitle] = useState("");
  const [createTaskDetails, setCreateTaskDetails] = useState("");
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Edit task dialog
  const [selectedTodo, setSelectedTodo] = useState(null);
  const [selectedTitle, setSelectedTitle] = useState("");
  const [selectedDetails, setSelectedDetails] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("todo");
  const [isSavingTodo, setIsSavingTodo] = useState(false);

  // Reassign confirm
  const [reassignPending, setReassignPending] = useState(null);
  const [isReassigning, setIsReassigning] = useState(false);

  async function fetchBootstrap() {
    setLoading(true);
    setPageError("");
    try {
      const res = await authFetch("/api/todo/bootstrap");
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to load todo data.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setCanWrite(data.canWrite ?? false);
      setOrgs(data.orgs ?? []);
      setMembers(data.members ?? []);
      setTodos(data.todos ?? []);
      setBoardOrgIds((cur) =>
        cur.length > 0 ? cur : (data.orgs ?? []).map((o) => o.orgId),
      );
      setBoardStaff((cur) =>
        cur.length > 0 ? cur : (data.members ?? []).slice(0, 5),
      );
    } catch (err) {
      if (isAuthExpired(err)) return;
      setPageError(err?.message ?? "Failed to load todo data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBootstrap();
  }, []);

  const memberMap = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      if (m.discordId) map.set(m.discordId, m);
    }
    return map;
  }, [members]);

  const orgNameById = useMemo(() => {
    const map = new Map();
    for (const o of orgs) map.set(o.orgId, o.name);
    return map;
  }, [orgs]);

  const effectiveBoardOrgIds = useMemo(() => {
    const set = new Set(orgs.map((o) => o.orgId));
    return boardOrgIds.filter((id) => set.has(id));
  }, [boardOrgIds, orgs]);

  const boardOrgLabel = useMemo(() => {
    if (!orgs.length) return "No orgs";
    if (!effectiveBoardOrgIds.length) return "No orgs selected";
    if (effectiveBoardOrgIds.length === orgs.length) return "All my orgs";
    return effectiveBoardOrgIds
      .map((id) => orgNameById.get(id) ?? id)
      .join(" · ");
  }, [effectiveBoardOrgIds, orgNameById, orgs.length]);

  const activeTodos = useMemo(() => {
    const allowed = new Set(effectiveBoardOrgIds);
    return todos.filter(
      (t) => allowed.has(t.orgId) && t.status !== "completed",
    );
  }, [todos, effectiveBoardOrgIds]);

  const completedTodos = useMemo(() => {
    const allowed = new Set(effectiveBoardOrgIds);
    const q = completedSearch.trim().toLowerCase();
    return todos
      .filter((t) => allowed.has(t.orgId) && t.status === "completed")
      .filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          (memberMap.get(t.assigneeDiscordId)?.username ?? "")
            .toLowerCase()
            .includes(q),
      );
  }, [todos, effectiveBoardOrgIds, completedSearch, memberMap]);

  const todosByAssignee = useMemo(() => {
    const map = new Map(boardStaff.map((s) => [s.discordId, []]));
    for (const t of activeTodos) {
      if (map.has(t.assigneeDiscordId)) {
        map.get(t.assigneeDiscordId).push(t);
      }
    }
    return map;
  }, [activeTodos, boardStaff]);

  const availableStaff = useMemo(
    () =>
      members.filter(
        (m) => !boardStaff.find((s) => s.discordId === m.discordId),
      ),
    [members, boardStaff],
  );

  function toggleBoardOrg(orgId) {
    setBoardOrgIds((cur) =>
      cur.includes(orgId)
        ? cur.filter((id) => id !== orgId)
        : [...cur, orgId],
    );
  }

  function addStaffToBoard(member) {
    if (!boardStaff.find((s) => s.discordId === member.discordId)) {
      setBoardStaff((cur) => [...cur, member]);
    }
  }

  function removeStaffFromBoard(discordId) {
    setBoardStaff((cur) => cur.filter((s) => s.discordId !== discordId));
  }

  async function quickComplete(todo, e) {
    e.stopPropagation();
    if (!canWrite) return;
    try {
      const res = await authFetch(`/api/todo/${todo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      if (res.ok) {
        setTodos((cur) =>
          cur.map((t) =>
            t.id === todo.id
              ? {
                  ...t,
                  status: "completed",
                  completedUnix: Math.floor(Date.now() / 1000),
                }
              : t,
          ),
        );
      }
    } catch (err) {
      if (isAuthExpired(err)) return;
    }
  }

  function openEditDialog(todo) {
    setSelectedTodo(todo);
    setSelectedTitle(todo.title ?? "");
    setSelectedDetails(todo.details ?? "");
    setSelectedStatus(todo.status ?? "todo");
  }

  function closeEditDialog() {
    setSelectedTodo(null);
  }

  async function handleSaveTodo(e) {
    e.preventDefault();
    if (!selectedTodo || !selectedTitle.trim()) return;
    setIsSavingTodo(true);
    try {
      const res = await authFetch(`/api/todo/${selectedTodo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: selectedTitle,
          details: selectedDetails,
          status: selectedStatus,
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to update task.");
        return;
      }
      setTodos((cur) =>
        cur.map((t) =>
          t.id === selectedTodo.id
            ? {
                ...t,
                title: selectedTitle,
                details: selectedDetails,
                status: selectedStatus,
                completedUnix:
                  selectedStatus === "completed"
                    ? Math.floor(Date.now() / 1000)
                    : null,
              }
            : t,
        ),
      );
      closeEditDialog();
    } catch (err) {
      if (isAuthExpired(err)) return;
      setPageError(err?.message ?? "Failed to update task.");
    } finally {
      setIsSavingTodo(false);
    }
  }

  async function handleDeleteTodo() {
    if (!selectedTodo) return;
    setIsSavingTodo(true);
    try {
      const res = await authFetch(`/api/todo/${selectedTodo.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to delete task.");
        return;
      }
      setTodos((cur) => cur.filter((t) => t.id !== selectedTodo.id));
      closeEditDialog();
    } catch (err) {
      if (isAuthExpired(err)) return;
    } finally {
      setIsSavingTodo(false);
    }
  }

  async function handleConfirmReassign() {
    if (!reassignPending) return;
    setIsReassigning(true);
    try {
      const res = await authFetch(`/api/todo/${reassignPending.todo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assigneeDiscordId: reassignPending.newAssigneeDiscordId,
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to reassign task.");
        return;
      }
      setTodos((cur) =>
        cur.map((t) =>
          t.id === reassignPending.todo.id
            ? { ...t, assigneeDiscordId: reassignPending.newAssigneeDiscordId }
            : t,
        ),
      );
      setReassignPending(null);
    } catch (err) {
      if (isAuthExpired(err)) return;
      setPageError(err?.message ?? "Failed to reassign task.");
    } finally {
      setIsReassigning(false);
    }
  }

  function openCreateDialog(staff) {
    setCreateTaskStaff(staff);
    setCreateTaskOrgId(effectiveBoardOrgIds[0] ?? orgs[0]?.orgId ?? "");
    setCreateTaskTitle("");
    setCreateTaskDetails("");
  }

  function closeCreateDialog() {
    setCreateTaskStaff(null);
    setCreateTaskTitle("");
    setCreateTaskDetails("");
  }

  async function handleCreateTask(e) {
    e.preventDefault();
    if (!createTaskStaff || !createTaskOrgId || !createTaskTitle.trim()) return;
    setIsCreatingTask(true);
    try {
      const res = await authFetch("/api/todo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: createTaskTitle,
          details: createTaskDetails,
          assigneeDiscordId: createTaskStaff.discordId,
          orgId: createTaskOrgId,
          status: "todo",
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to create task.");
        return;
      }
      const data = await res.json();
      setTodos((cur) => [data.todo, ...cur]);
      closeCreateDialog();
    } catch (err) {
      if (isAuthExpired(err)) return;
      setPageError(err?.message ?? "Failed to create task.");
    } finally {
      setIsCreatingTask(false);
    }
  }

  if (loading) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Todo</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Assign and track tasks across staff.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-0.5 bg-surface/60 ring-1 ring-border rounded-md p-0.5">
                <button
                  onClick={() => setView("board")}
                  className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors ${
                    view === "board"
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Board
                </button>
                <button
                  onClick={() => setView("completed")}
                  className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded transition-colors ${
                    view === "completed"
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Completed
                </button>
              </div>
              <OrgFilterPopover
                orgs={orgs}
                effectiveIds={effectiveBoardOrgIds}
                label={boardOrgLabel}
                onToggle={toggleBoardOrg}
                onSetAll={(all) =>
                  setBoardOrgIds(all ? orgs.map((o) => o.orgId) : [])
                }
              />
            </div>
          </div>

          {pageError && (
            <div className="rounded-md ring-1 ring-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-center justify-between gap-2">
              <span>{pageError}</span>
              <button onClick={() => setPageError("")} className="shrink-0">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {view === "board" ? (
            <BoardView
              boardStaff={boardStaff}
              todosByAssignee={todosByAssignee}
              orgNameById={orgNameById}
              canWrite={canWrite}
              availableStaff={availableStaff}
              dragOverStaff={dragOverStaff}
              onDragStart={(todo) => setDraggedTodo(todo)}
              onDragOver={(e, id) => {
                e.preventDefault();
                setDragOverStaff(id);
              }}
              onDragLeave={() => setDragOverStaff(null)}
              onDrop={(staffDiscordId) => {
                setDragOverStaff(null);
                if (
                  draggedTodo &&
                  draggedTodo.assigneeDiscordId !== staffDiscordId
                ) {
                  const newAssignee = memberMap.get(staffDiscordId);
                  setReassignPending({
                    todo: draggedTodo,
                    newAssigneeDiscordId: staffDiscordId,
                    newAssigneeName:
                      newAssignee?.username ?? staffDiscordId,
                  });
                }
                setDraggedTodo(null);
              }}
              onOpenCreate={openCreateDialog}
              onOpenEdit={openEditDialog}
              onRemoveStaff={removeStaffFromBoard}
              onAddStaff={addStaffToBoard}
              onQuickComplete={quickComplete}
            />
          ) : (
            <CompletedView
              todos={completedTodos}
              memberMap={memberMap}
              orgNameById={orgNameById}
              search={completedSearch}
              onSearchChange={setCompletedSearch}
              onOpenEdit={openEditDialog}
            />
          )}
        </div>
      </main>

      {/* Create task dialog */}
      <Dialog
        open={createTaskStaff !== null}
        onOpenChange={(open) => !open && closeCreateDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
            <DialogDescription>
              Assign to {createTaskStaff?.username ?? ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateTask} className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label>Organization</Label>
              <Select
                value={createTaskOrgId}
                onValueChange={setCreateTaskOrgId}
                disabled={isCreatingTask}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select org" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.orgId} value={o.orgId}>
                      {o.name || o.orgId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={createTaskTitle}
                onChange={(e) => setCreateTaskTitle(e.target.value)}
                placeholder="Task title"
                required
                disabled={isCreatingTask}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Details</Label>
              <Textarea
                value={createTaskDetails}
                onChange={(e) => setCreateTaskDetails(e.target.value)}
                placeholder="Optional notes…"
                rows={3}
                disabled={isCreatingTask}
              />
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={closeCreateDialog}
                disabled={isCreatingTask}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isCreatingTask || !createTaskOrgId || !createTaskTitle.trim()
                }
              >
                {isCreatingTask && (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                )}
                <Plus className="size-3.5 mr-1" />
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit task dialog */}
      <Dialog
        open={selectedTodo !== null}
        onOpenChange={(open) => !open && closeEditDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Task Details</DialogTitle>
            <DialogDescription>
              {orgNameById.get(selectedTodo?.orgId) ?? ""} ·{" "}
              {memberMap.get(selectedTodo?.assigneeDiscordId)?.username ??
                "Unassigned"}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveTodo} className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={selectedTitle}
                onChange={(e) => setSelectedTitle(e.target.value)}
                disabled={isSavingTodo || !canWrite}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Details</Label>
              <Textarea
                value={selectedDetails}
                onChange={(e) => setSelectedDetails(e.target.value)}
                rows={4}
                disabled={isSavingTodo || !canWrite}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={selectedStatus}
                onValueChange={setSelectedStatus}
                disabled={isSavingTodo || !canWrite}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo">Todo</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {canWrite && (
              <div className="flex gap-2 justify-between pt-1">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteTodo}
                  disabled={isSavingTodo}
                >
                  <Trash2 className="size-3.5 mr-1" /> Delete
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={closeEditDialog}
                    disabled={isSavingTodo}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={isSavingTodo || !selectedTitle.trim()}
                  >
                    {isSavingTodo && (
                      <Loader2 className="size-3.5 mr-1 animate-spin" />
                    )}
                    Save
                  </Button>
                </div>
              </div>
            )}
          </form>
        </DialogContent>
      </Dialog>

      {/* Reassign confirm */}
      <Dialog
        open={reassignPending !== null}
        onOpenChange={(open) => !open && setReassignPending(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Task</DialogTitle>
            <DialogDescription>
              Move to {reassignPending?.newAssigneeName}?
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-surface/60 ring-1 ring-border p-3 my-1">
            <p className="text-sm font-medium">{reassignPending?.todo.title}</p>
            {reassignPending?.todo.details && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {reassignPending.todo.details}
              </p>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => setReassignPending(null)}
              disabled={isReassigning}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmReassign} disabled={isReassigning}>
              {isReassigning && (
                <Loader2 className="size-3.5 mr-1 animate-spin" />
              )}
              Reassign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OrgFilterPopover({ orgs, effectiveIds, label, onToggle, onSetAll }) {
  const allSelected = effectiveIds.length === orgs.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface transition-colors">
          <Building2 className="size-3.5 text-brand shrink-0" />
          <div className="flex flex-col items-start leading-tight min-w-0">
            <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
              Board orgs
            </span>
            <span className="text-xs font-semibold truncate max-w-[200px]">
              {label}
            </span>
          </div>
          <ChevronDown className="size-3 text-muted-foreground ml-1" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Filter orgs
          </span>
          <button
            onClick={() => onSetAll(!allSelected)}
            className="text-[10px] font-semibold text-brand hover:underline"
          >
            {allSelected ? "Clear" : "Select all"}
          </button>
        </div>
        <div className="space-y-0.5">
          {orgs.map((org) => {
            const checked = effectiveIds.includes(org.orgId);
            return (
              <button
                key={org.orgId}
                onClick={() => onToggle(org.orgId)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
              >
                <span
                  className={
                    "size-4 rounded-sm grid place-items-center ring-1 " +
                    (checked
                      ? "bg-brand ring-brand text-brand-foreground"
                      : "ring-border text-transparent")
                  }
                >
                  <Check className="size-3" />
                </span>
                <span className="text-xs font-medium truncate">{org.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BoardView({
  boardStaff,
  todosByAssignee,
  orgNameById,
  canWrite,
  availableStaff,
  dragOverStaff,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenCreate,
  onOpenEdit,
  onRemoveStaff,
  onAddStaff,
  onQuickComplete,
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-3 items-start">
      {boardStaff.map((staff) => {
        const cards = todosByAssignee.get(staff.discordId) ?? [];
        const isOver = dragOverStaff === staff.discordId;
        return (
          <div
            key={staff.discordId}
            className={
              "w-[280px] shrink-0 rounded-md ring-1 flex flex-col max-h-[calc(100vh-200px)] transition-colors " +
              (isOver ? "ring-brand/50 bg-brand/5" : "ring-border bg-surface/40")
            }
            onDragOver={(e) => onDragOver(e, staff.discordId)}
            onDragLeave={onDragLeave}
            onDrop={() => onDrop(staff.discordId)}
          >
            <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2 sticky top-0 bg-surface/80 backdrop-blur rounded-t-md z-10">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">
                  {staff.username}
                </div>
                <div className="text-[9px] font-mono uppercase tracking-widest text-brand">
                  {cards.length} task{cards.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {canWrite && (
                  <button
                    onClick={() => onOpenCreate(staff)}
                    className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border hover:bg-brand/15 hover:text-brand hover:ring-brand/40 transition-colors"
                    title="Add task"
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => onRemoveStaff(staff.discordId)}
                  className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Remove from board"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>

            <div className="p-2 space-y-2 overflow-y-auto min-h-[60px]">
              {cards.length === 0 ? (
                <div className="text-[10px] text-muted-foreground text-center py-8">
                  No active tasks
                </div>
              ) : (
                cards.map((todo) => (
                  <TaskCard
                    key={todo.id}
                    todo={todo}
                    orgName={orgNameById.get(todo.orgId) ?? todo.orgId}
                    canWrite={canWrite}
                    onDragStart={() => onDragStart(todo)}
                    onClick={() => onOpenEdit(todo)}
                    onQuickComplete={(e) => onQuickComplete(todo, e)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}

      {availableStaff.length > 0 && (
        <AddStaffPopover staff={availableStaff} onAdd={onAddStaff} />
      )}

      {boardStaff.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-24 text-center">
          <Users className="size-8 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium">No staff on board</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add staff members to start tracking their tasks.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard({ todo, orgName, canWrite, onDragStart, onClick, onQuickComplete }) {
  const meta = metaFor(todo.status);
  return (
    <button
      draggable={canWrite}
      onDragStart={onDragStart}
      onClick={onClick}
      className={`group w-full text-left rounded-md ring-1 p-2.5 space-y-1.5 transition-colors ${meta.card}`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-xs font-medium leading-snug flex-1">{todo.title}</span>
        {canWrite && (
          <button
            onClick={onQuickComplete}
            className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-emerald-500"
            title="Mark complete"
          >
            <CheckCircle2 className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono text-muted-foreground truncate">
          {orgName}
        </span>
        {todo.status !== "todo" && (
          <Badge
            variant="outline"
            className={`text-[9px] font-mono h-4 px-1.5 shrink-0 ${meta.badge}`}
          >
            {meta.label}
          </Badge>
        )}
      </div>
      {todo.details && (
        <p className="text-[10px] text-muted-foreground line-clamp-2">
          {todo.details}
        </p>
      )}
    </button>
  );
}

function AddStaffPopover({ staff, onAdd }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = staff.filter((m) =>
    m.username.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="w-[200px] shrink-0 rounded-md ring-1 ring-dashed ring-border bg-surface/20 hover:bg-surface/40 text-xs text-muted-foreground hover:text-foreground py-3 px-3 inline-flex items-center justify-center gap-2 self-start transition-colors"
          type="button"
        >
          <UserPlus className="size-3.5" />
          Add staff to board
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        <div className="px-1 pb-1.5">
          <div className="relative">
            <Search className="size-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search staff…"
              className="h-7 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="space-y-0.5 max-h-60 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-[11px] text-muted-foreground text-center py-3">
              No results
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.discordId}
                onClick={() => {
                  onAdd(m);
                  setOpen(false);
                  setQ("");
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-surface text-xs flex items-center gap-2"
              >
                <span className="size-6 rounded-full bg-brand/15 text-brand grid place-items-center text-[10px] font-bold shrink-0">
                  {m.username[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="truncate">{m.username}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CompletedView({
  todos,
  memberMap,
  orgNameById,
  search,
  onSearchChange,
  onOpenEdit,
}) {
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search completed tasks…"
          className="pl-9 h-8 text-sm"
        />
      </div>

      {todos.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <CheckCircle2 className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {search ? "No matching completed tasks" : "No completed tasks yet"}
          </p>
        </div>
      ) : (
        <div className="ring-1 ring-border rounded-md overflow-hidden">
          <div className="grid grid-cols-[1fr_160px_160px_80px] gap-3 px-3 py-2 border-b border-border bg-surface/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            <div>Task</div>
            <div>Assignee</div>
            <div>Org</div>
            <div>Done</div>
          </div>
          {todos.map((todo) => {
            const assignee = memberMap.get(todo.assigneeDiscordId);
            return (
              <button
                key={todo.id}
                onClick={() => onOpenEdit(todo)}
                className="w-full grid grid-cols-[1fr_160px_160px_80px] gap-3 px-3 py-2.5 border-b border-border last:border-0 items-center text-left hover:bg-surface/60 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{todo.title}</p>
                  {todo.details && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {todo.details}
                    </p>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {assignee?.username ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {orgNameById.get(todo.orgId) ?? todo.orgId}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground">
                  {fmtDate(todo.completedUnix)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
