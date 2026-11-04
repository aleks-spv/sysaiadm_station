import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { InventoryNode } from "@sysadm/shared";
import { History, Loader2, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/utils";
import { fmtDateTime } from "@/i18n";
import { serverMsg } from "@/i18n/server";
import ScheduleDialog from "./ScheduleDialog";
import type { Job, Run, Schedule } from "./types";
import { t } from "./i18n";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const DAY_SHORT = [t("day.sun"), t("day.mon"), t("day.tue"), t("day.wed"), t("day.thu"), t("day.fri"), t("day.sat")]; // index = contract day (0 = Sunday)
const BADGE = "rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (ts: number | null) => (ts ? fmtDateTime(ts) : "—");

function scheduleText(s: Schedule): string {
  switch (s.kind) {
    case "once": {
      const d = new Date(s.at);
      return t("schedule.once", { at: `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` });
    }
    case "daily":
      return t("schedule.daily", { time: s.time });
    case "weekly":
      return t("schedule.weekly", {
        days: WEEK_ORDER.filter((d) => s.days.includes(d))
          .map((d) => DAY_SHORT[d])
          .join(", "),
        time: s.time,
      });
    case "monthly":
      return t("schedule.monthly", { day: s.day, time: s.time });
  }
}

/* ── Row component ──────────────────────────────────────────────────────────── */

interface JobRowProps {
  job: Job;
  editable: boolean;
  historyOpen: boolean;
  runs: Run[] | null;
  onRun: () => void;
  onPause: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}

function JobRow({ job, editable, historyOpen, runs, onRun, onPause, onEdit, onHistory, onDelete }: JobRowProps) {
  return (
    <div className="border-b border-border px-4 py-2 hover:bg-muted/30">
      <div className="flex items-center gap-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{job.title}</span>
            {!job.enabled && <span className={BADGE}>{t("badge.paused")}</span>}
            {job.autopilot && <span className={BADGE}>{t("badge.autopilot")}</span>}
          </div>
          <div className="text-xs text-muted-foreground">
            {scheduleText(job.schedule)} · {t("job.agent", { agent: job.agent ?? t("agent.default") })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("job.nextLast", { next: fmt(job.nextRunAt), last: fmt(job.lastRunAt) })}
            {job.lastTaskId && (
              <>
                {" · "}
                <Link to={`/nodes/${job.nodeId}/tasks/${job.lastTaskId}`} className="underline hover:text-foreground">
                  {t("link.task")}
                </Link>
              </>
            )}
          </div>
          {job.lastError && <p className="text-xs text-destructive">{serverMsg(job.lastError)}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon-xs" variant="ghost" title={t("action.runNow")} onClick={onRun}>
            <Play />
          </Button>
          <Button size="icon-xs" variant="ghost" title={job.enabled ? t("action.pause") : t("action.resume")} onClick={onPause}>
            {job.enabled ? <Pause /> : <Play />}
          </Button>
          <Button size="icon-xs" variant="ghost" title={t("action.edit")} disabled={!editable} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" title={t("action.history")} onClick={onHistory}>
            <History />
          </Button>
          <Button size="icon-xs" variant="ghost" title={t("action.delete")} className="hover:text-destructive" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>

      {historyOpen && (
        <div className="mt-1.5 grid gap-1 border-t border-border pt-2 text-xs">
          {runs === null ? (
            <span className="text-muted-foreground">{t("loading")}</span>
          ) : runs.length === 0 ? (
            <span className="text-muted-foreground">{t("history.empty")}</span>
          ) : (
            runs.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground">{fmt(r.ts)}</span>
                {r.taskId && (
                  <Link to={`/nodes/${job.nodeId}/tasks/${r.taskId}`} className="underline hover:text-foreground">
                    {t("link.task")}
                  </Link>
                )}
                {r.error && <span className="text-destructive">{serverMsg(r.error)}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Page component ─────────────────────────────────────────────────────────── */

export default function SchedulerPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [nodes, setNodes] = useState<InventoryNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Job | null>(null);
  const [openRuns, setOpenRuns] = useState<{ id: string; runs: Run[] | null } | null>(null);

  const nodeById = new Map<string, InventoryNode>(nodes.map((n) => [n.id, n]));
  const editingNode = editing ? nodeById.get(editing.nodeId) : undefined;

  /* ── Polling ─────────────────────────────────────────────────────────────── */

  const poll = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const [list, tree] = await Promise.all([api.plugin<Job[]>("scheduler", "GET", "/jobs"), api.tree()]);
      setJobs(list);
      setNodes(tree);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 15_000);
    return () => clearInterval(interval);
  }, [poll]);

  /* ── Actions ─────────────────────────────────────────────────────────────── */

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await poll();
    } catch (err: unknown) {
      setError(errorText(err));
    }
  };

  const handleDelete = (job: Job) => {
    if (!window.confirm(t("confirm.delete", { title: job.title }))) return;
    act(() => api.plugin<{ ok: true }>("scheduler", "DELETE", `/jobs/${job.id}`));
  };

  const toggleHistory = (id: string) => {
    if (openRuns?.id === id) {
      setOpenRuns(null);
      return;
    }
    setOpenRuns({ id, runs: null });
    api
      .plugin<Run[]>("scheduler", "GET", `/jobs/${id}/runs`)
      .then((runs) => setOpenRuns((cur) => (cur?.id === id ? { id, runs } : cur)))
      .catch((err: unknown) => {
        setOpenRuns(null);
        setError(errorText(err));
      });
  };

  /* ── Grouping by node ────────────────────────────────────────────────────── */

  const byNode = new Map<string, Job[]>();
  for (const job of jobs ?? []) byNode.set(job.nodeId, [...(byNode.get(job.nodeId) ?? []), job]);
  const groups = [...byNode].sort(([a], [b]) => (nodeById.get(a)?.name ?? "").localeCompare(nodeById.get(b)?.name ?? ""));

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-sm font-medium truncate">{t("title")}</h1>
        <span className="text-xs text-muted-foreground">{t("total", { n: jobs?.length ?? 0 })}</span>
      </header>

      {error && <p className="mx-3 mt-2 text-xs text-destructive">{error}</p>}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto">
        {jobs === null ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="ml-2">{t("loading")}</span>
          </div>
        ) : jobs.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          groups.map(([nodeId, list]) => {
            const node = nodeById.get(nodeId);
            return (
              <section key={nodeId}>
                <h2 className="border-b border-border bg-muted/40 px-4 py-1 text-xs font-medium">
                  {node ? (
                    <Link to={`/nodes/${node.id}`} className="hover:underline">
                      {node.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{t("node.deleted")}</span>
                  )}
                </h2>
                {list.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    editable={!!node}
                    historyOpen={openRuns?.id === job.id}
                    runs={openRuns?.id === job.id ? openRuns.runs : null}
                    onRun={() => act(() => api.plugin<{ taskId: string }>("scheduler", "POST", `/jobs/${job.id}/run`))}
                    onPause={() => act(() => api.plugin<Job>("scheduler", "PUT", `/jobs/${job.id}`, { enabled: !job.enabled }))}
                    onEdit={() => setEditing(job)}
                    onHistory={() => toggleHistory(job.id)}
                    onDelete={() => handleDelete(job)}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>

      {editing && editingNode && (
        <ScheduleDialog
          node={editingNode}
          job={editing}
          onClose={() => {
            setEditing(null);
            poll();
          }}
        />
      )}
    </div>
  );
}
