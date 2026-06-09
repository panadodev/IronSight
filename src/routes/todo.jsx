import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import {
  Building2,
  Check,
  ChevronDown,
  Plus,
  Trash2,
  UserPlus,
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

function isAuthExpired(error) {
  return error?.code === "AUTH_EXPIRED";
}

export const Route = createFileRoute("/todo")({
  head: () => ({ meta: [{ title: "Todo - IronSight" }] }),
  component: TodoPage,
});

const STATUS_COLORS = {
  todo: "bg-yellow-500/15 ring-yellow-500/40 hover:bg-yellow-500/20",
  completed: "bg-emerald-500/15 ring-emerald-500/40 hover:bg-emerald-500/20",
  "in progress": "bg-red-500/15 ring-red-500/40 hover:bg-red-500/20",
  blocked: "bg-blue-500/15 ring-blue-500/40 hover:bg-blue-500/20",
};

const ROLE_ABBREV = {
  support: "SUP",
  senior: "SR",
  admin: "ADM",
  management: "MGMT",
};

function TodoPage() {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [sessionUser, setSessionUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [todos, setTodos] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [boardOrgIds, setBoardOrgIds] = useState([]);
  const [boardStaff, setBoardStaff] = useState([]);
  const [view, setView] = useState("board");
  const [draggedTodo, setDraggedTodo] = useState(null);
  const [createTaskStaff, setCreateTaskStaff] = useState(null);
  const [createTaskOrgId, setCreateTaskOrgId] = useState("");
  const [createTaskTitle, setCreateTaskTitle] = useState("");
  const [createTaskDetails, setCreateTaskDetails] = useState("");
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState(null);
  const [selectedTodoTitle, setSelectedTodoTitle] = useState("");
  const [selectedTodoDetails, setSelectedTodoDetails] = useState("");
  const [selectedTodoStatus, setSelectedTodoStatus] = useState("todo");
  const [isSavingTodo, setIsSavingTodo] = useState(false);
  const [reassignmentPending, setReassignmentPending] = useState(null);
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
      setSessionUser(data.user);
      setOrgs(data.orgs ?? []);
      setMembers(data.members ?? []);
      setTodos(data.todos ?? []);

      const firstOrgId = data.orgs?.[0]?.orgId ?? "";
      setSelectedOrgId((current) => current || firstOrgId);
      setBoardOrgIds((current) =>
        current.length > 0
          ? current
          : (data.orgs ?? []).map((org) => org.orgId),
      );

      // Initialize board staff with org members
      if (data.members && data.members.length > 0) {
        setBoardStaff(data.members.slice(0, 5));
      }

      setLoading(false);
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to load todo data.");
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBootstrap();
  }, []);

  const memberMap = useMemo(() => {
    const map = new Map();
    for (const member of members) {
      if (member.discordId) map.set(member.discordId, member);
    }
    return map;
  }, [members]);

  const orgNameById = useMemo(() => {
    const map = new Map();
    for (const org of orgs) {
      map.set(org.orgId, org.name);
    }
    return map;
  }, [orgs]);

  const effectiveBoardOrgIds = useMemo(() => {
    const existingOrgIds = new Set(orgs.map((org) => org.orgId));
    return boardOrgIds.filter((orgId) => existingOrgIds.has(orgId));
  }, [boardOrgIds, orgs]);

  const boardOrgLabel = useMemo(() => {
    if (orgs.length === 0) return "No orgs";
    if (effectiveBoardOrgIds.length === 0) return "No orgs selected";
    if (effectiveBoardOrgIds.length === orgs.length) return "All my orgs";
    return effectiveBoardOrgIds
      .map((orgId) => orgNameById.get(orgId) ?? orgId)
      .join(" · ");
  }, [effectiveBoardOrgIds, orgNameById, orgs.length]);

  const visibleTodos = useMemo(() => {
    const allowedOrgIds = new Set(effectiveBoardOrgIds);
    const filtered = todos.filter(
      (t) =>
        allowedOrgIds.has(t.orgId) &&
        (view === "board"
          ? t.status !== "completed"
          : t.status === "completed"),
    );
    return filtered;
  }, [todos, effectiveBoardOrgIds, view]);

  function toggleBoardOrg(orgId) {
    setBoardOrgIds((current) =>
      current.includes(orgId)
        ? current.filter((id) => id !== orgId)
        : [...current, orgId],
    );
  }

  const todosByAssignee = useMemo(() => {
    const map = new Map();
    for (const staff of boardStaff) {
      map.set(staff.discordId, []);
    }
    for (const todo of visibleTodos) {
      if (map.has(todo.assigneeDiscordId)) {
        map.get(todo.assigneeDiscordId).push(todo);
      }
    }
    return map;
  }, [visibleTodos, boardStaff]);

  function addStaffToBoard(member) {
    if (!boardStaff.find((s) => s.discordId === member.discordId)) {
      setBoardStaff((current) => [...current, member]);
    }
  }

  function removeStaffFromBoard(discordId) {
    setBoardStaff((current) =>
      current.filter((s) => s.discordId !== discordId),
    );
  }

  function handleDragStart(todo) {
    setDraggedTodo(todo);
  }

  function handleDragOver(e) {
    e.preventDefault();
  }

  function handleDrop(staffDiscordId) {
    if (draggedTodo && draggedTodo.assigneeDiscordId !== staffDiscordId) {
      const newAssignee = memberMap.get(staffDiscordId);
      setReassignmentPending({
        todo: draggedTodo,
        newAssigneeDiscordId: staffDiscordId,
        newAssigneeName: newAssignee?.username || staffDiscordId,
      });
    }
    setDraggedTodo(null);
  }

  function openTodoEditor(todo) {
    setSelectedTodo(todo);
    setSelectedTodoTitle(todo.title || "");
    setSelectedTodoDetails(todo.details || "");
    setSelectedTodoStatus(todo.status || "todo");
  }

  function closeTodoEditor() {
    setSelectedTodo(null);
    setSelectedTodoTitle("");
    setSelectedTodoDetails("");
    setSelectedTodoStatus("todo");
  }

  async function handleSaveTodoChanges(e) {
    e.preventDefault();
    if (!selectedTodo || !selectedTodoTitle.trim()) return;

    setIsSavingTodo(true);
    setPageError("");

    try {
      const res = await authFetch(`/api/todo/${selectedTodo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: selectedTodoTitle,
          details: selectedTodoDetails,
          status: selectedTodoStatus,
        }),
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to update task.");
        setIsSavingTodo(false);
        return;
      }

      setTodos((current) =>
        current.map((t) =>
          t.id === selectedTodo.id
            ? {
                ...t,
                title: selectedTodoTitle,
                details: selectedTodoDetails,
                status: selectedTodoStatus,
              }
            : t,
        ),
      );
      closeTodoEditor();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to update task.");
    } finally {
      setIsSavingTodo(false);
    }
  }

  async function handleDeleteSelectedTodo() {
    if (!selectedTodo) return;

    setIsSavingTodo(true);
    setPageError("");

    try {
      const res = await authFetch(`/api/todo/${selectedTodo.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to delete task.");
        setIsSavingTodo(false);
        return;
      }

      setTodos((current) => current.filter((t) => t.id !== selectedTodo.id));
      closeTodoEditor();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to delete task.");
    } finally {
      setIsSavingTodo(false);
    }
  }

  async function handleConfirmReassignment() {
    if (!reassignmentPending) return;

    setIsReassigning(true);
    setPageError("");

    try {
      const res = await authFetch(`/api/todo/${reassignmentPending.todo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assigneeDiscordId: reassignmentPending.newAssigneeDiscordId,
        }),
      });

      if (!res.ok) {
        const body = await safeJson(res);
        setPageError(body?.error ?? "Failed to reassign task.");
        setIsReassigning(false);
        return;
      }

      setTodos((current) =>
        current.map((t) =>
          t.id === reassignmentPending.todo.id
            ? {
                ...t,
                assigneeDiscordId: reassignmentPending.newAssigneeDiscordId,
              }
            : t,
        ),
      );
      setReassignmentPending(null);
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to reassign task.");
    } finally {
      setIsReassigning(false);
    }
  }

  function openCreateTaskDialog(staff) {
    setCreateTaskStaff(staff);
    setCreateTaskOrgId((current) => {
      if (current) return current;
      return effectiveBoardOrgIds[0] ?? orgs[0]?.orgId ?? "";
    });
  }

  function closeCreateTaskDialog() {
    setCreateTaskStaff(null);
    setCreateTaskOrgId("");
    setCreateTaskTitle("");
    setCreateTaskDetails("");
  }

  async function handleCreateTask(e) {
    e.preventDefault();
    if (!createTaskStaff || !createTaskOrgId || !createTaskTitle.trim()) return;

    setIsCreatingTask(true);
    setPageError("");

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
        setIsCreatingTask(false);
        return;
      }

      const data = await res.json();
      setTodos((current) => [...current, data.todo]);
      closeCreateTaskDialog();
    } catch (error) {
      if (isAuthExpired(error)) return;
      setPageError(error?.message ?? "Failed to create task.");
    } finally {
      setIsCreatingTask(false);
    }
  }

  const availableStaff = useMemo(
    () =>
      members.filter(
        (m) => !boardStaff.find((s) => s.discordId === m.discordId),
      ),
    [members, boardStaff],
  );

  if (loading) {
    return (
      <div className="h-screen w-full flex flex-col bg-background">
        <SiteNav />
        <div className="flex-1 grid place-items-center">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background">
      <SiteNav />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-6 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Todo</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Assign tasks across staff. Cards respect the visibility tier
                they were created with.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 bg-surface/60 ring-1 ring-border rounded-md p-0.5">
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
              <Popover>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-md ring-1 ring-border bg-surface/40 hover:bg-surface transition-colors">
                    <Building2 className="size-3.5 text-brand" />
                    <div className="flex flex-col items-start leading-tight min-w-0">
                      <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                        Board Orgs
                      </span>
                      <span className="text-xs font-semibold truncate max-w-[240px]">
                        {boardOrgLabel}
                      </span>
                    </div>
                    <ChevronDown className="size-3 text-muted-foreground ml-1" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-2">
                  <div className="flex items-center justify-between px-2 pb-2 mb-1 border-b border-border">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      Filter Board Orgs
                    </span>
                    <button
                      onClick={() => {
                        const allOrgIds = orgs.map((org) => org.orgId);
                        setBoardOrgIds(
                          effectiveBoardOrgIds.length === allOrgIds.length
                            ? []
                            : allOrgIds,
                        );
                      }}
                      className="text-[10px] font-semibold text-brand hover:underline"
                    >
                      {effectiveBoardOrgIds.length === orgs.length
                        ? "Clear"
                        : "Select all"}
                    </button>
                  </div>
                  <div className="space-y-0.5">
                    {orgs.map((org) => {
                      const checked = effectiveBoardOrgIds.includes(org.orgId);
                      return (
                        <button
                          key={org.orgId}
                          onClick={() => toggleBoardOrg(org.orgId)}
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
                          <span className="text-xs font-medium flex-1 truncate">
                            {org.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {pageError ? (
            <div className="rounded-md ring-1 ring-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {pageError}
            </div>
          ) : null}

          <div className="flex gap-3 overflow-x-auto pb-3 items-start">
            {boardStaff.map((staff) => {
              const staffTodos = todosByAssignee.get(staff.discordId) ?? [];
              const role = staff.role || "support";
              const roleAbbr = ROLE_ABBREV[role.toLowerCase()] || "USR";

              return (
                <div
                  key={staff.discordId}
                  className="w-[280px] shrink-0 rounded-md ring-1 bg-surface/40 flex flex-col max-h-[calc(100vh-220px)] transition-colors ring-border"
                >
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 sticky top-0 bg-surface/80 backdrop-blur rounded-t-md">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {staff.username}
                      </div>
                      <div className="text-[9px] font-mono uppercase tracking-widest text-brand">
                        {roleAbbr} · {staffTodos.length}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openCreateTaskDialog(staff)}
                        className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border transition-colors hover:bg-brand/15 hover:text-brand hover:ring-brand/40"
                        title="Add card"
                      >
                        <Plus className="size-3.5" />
                      </button>
                      <button
                        onClick={() => removeStaffFromBoard(staff.discordId)}
                        className="size-7 inline-flex items-center justify-center rounded ring-1 ring-border text-danger hover:bg-danger/10"
                        title="Remove from board"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                  <div
                    className="p-2 space-y-2 overflow-y-auto min-h-[40px]"
                    onDragOver={handleDragOver}
                    onDrop={() => handleDrop(staff.discordId)}
                  >
                    {staffTodos.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground px-2 py-6 text-center">
                        No cards.
                      </div>
                    ) : (
                      staffTodos.map((todo) => {
                        const colorClass =
                          STATUS_COLORS[todo.status] || STATUS_COLORS.todo;

                        return (
                          <button
                            key={todo.id}
                            draggable
                            onDragStart={() => handleDragStart(todo)}
                            onClick={() => openTodoEditor(todo)}
                            className={`w-full text-left rounded-md ring-1 p-2.5 space-y-1.5 cursor-grab active:cursor-grabbing ${colorClass}`}
                          >
                            <div className="text-xs font-medium leading-snug">
                              {todo.title}
                            </div>
                            <div className="text-[10px] font-mono text-muted-foreground flex items-center justify-between gap-2">
                              <span className="truncate">
                                {orgNameById.get(todo.orgId) ?? todo.orgId} ·{" "}
                                {todo.visibility || "Public"}
                              </span>
                              {todo.status === "in progress" && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold ring-1 bg-brand/15 text-brand ring-brand/40">
                                  IN PROGRESS
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}

            {availableStaff.length > 0 && (
              <button
                onClick={() => {
                  // Show modal to pick staff member
                  if (availableStaff[0]) {
                    addStaffToBoard(availableStaff[0]);
                  }
                }}
                className="w-[200px] shrink-0 rounded-md ring-1 ring-dashed ring-border bg-surface/20 hover:bg-surface/40 text-xs text-muted-foreground hover:text-foreground py-3 px-3 inline-flex items-center justify-center gap-2 self-start transition-colors"
                type="button"
              >
                <UserPlus className="size-3.5" />
                Add staff to board
              </button>
            )}
          </div>

          <Dialog
            open={createTaskStaff !== null}
            onOpenChange={(open) => !open && closeCreateTaskDialog()}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Task</DialogTitle>
                <DialogDescription>
                  Assign to {createTaskStaff?.username || "staff member"}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateTask} className="grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Organization</label>
                  <select
                    value={createTaskOrgId}
                    onChange={(e) => setCreateTaskOrgId(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    disabled={isCreatingTask}
                    required
                  >
                    <option value="" disabled>
                      Select org_id
                    </option>
                    {orgs.map((org) => (
                      <option key={org.orgId} value={org.orgId}>
                        {org.name || org.orgId}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Title</label>
                  <Input
                    value={createTaskTitle}
                    onChange={(e) => setCreateTaskTitle(e.target.value)}
                    placeholder="Task title"
                    required
                    disabled={isCreatingTask}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Details</label>
                  <Textarea
                    value={createTaskDetails}
                    onChange={(e) => setCreateTaskDetails(e.target.value)}
                    placeholder="Task details (optional)"
                    rows={3}
                    disabled={isCreatingTask}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeCreateTaskDialog}
                    disabled={isCreatingTask}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      isCreatingTask ||
                      !createTaskOrgId ||
                      !createTaskTitle.trim()
                    }
                  >
                    {isCreatingTask ? "Creating..." : "Create Task"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog
            open={reassignmentPending !== null}
            onOpenChange={(open) => !open && setReassignmentPending(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reassign Task</DialogTitle>
                <DialogDescription>
                  Move "{reassignmentPending?.todo.title}" to{" "}
                  {reassignmentPending?.newAssigneeName}?
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="rounded-md bg-surface/60 ring-1 ring-border p-3">
                  <div className="text-sm font-medium mb-1">Task</div>
                  <div className="text-xs text-muted-foreground">
                    {reassignmentPending?.todo.title}
                  </div>
                  {reassignmentPending?.todo.details && (
                    <div className="text-xs text-muted-foreground mt-2">
                      {reassignmentPending.todo.details}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setReassignmentPending(null)}
                    disabled={isReassigning}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleConfirmReassignment}
                    disabled={isReassigning}
                  >
                    {isReassigning ? "Saving..." : "Confirm Reassignment"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog
            open={selectedTodo !== null}
            onOpenChange={(open) => !open && closeTodoEditor()}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Task Details</DialogTitle>
                <DialogDescription>
                  Update details, status, or complete this task.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSaveTodoChanges} className="grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Title</label>
                  <Input
                    value={selectedTodoTitle}
                    onChange={(e) => setSelectedTodoTitle(e.target.value)}
                    placeholder="Task title"
                    required
                    disabled={isSavingTodo}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Details</label>
                  <Textarea
                    value={selectedTodoDetails}
                    onChange={(e) => setSelectedTodoDetails(e.target.value)}
                    placeholder="Task details"
                    rows={4}
                    disabled={isSavingTodo}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Status</label>
                  <select
                    value={selectedTodoStatus}
                    onChange={(e) => setSelectedTodoStatus(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    disabled={isSavingTodo}
                  >
                    <option value="todo">Todo</option>
                    <option value="in progress">In Progress</option>
                    <option value="blocked">Blocked</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>

                <div className="flex gap-2 justify-between">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleDeleteSelectedTodo}
                    disabled={isSavingTodo}
                  >
                    Delete
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSelectedTodoStatus("completed")}
                      disabled={isSavingTodo}
                    >
                      Mark Complete
                    </Button>
                    <Button
                      type="submit"
                      disabled={isSavingTodo || !selectedTodoTitle.trim()}
                    >
                      {isSavingTodo ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
