import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { InventoryNode, Task, TaskStatus } from "@sysadm/shared";
import { api, subscribeEvents } from "../api";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { fmtDateTime } from "@/i18n";
import { t as tr } from "@/i18n/app";

const STATUSES: Array<TaskStatus | ""> = ["", "running", "waiting_permission", "idle", "stopped", "error"];
const STATUS_LABEL: Record<TaskStatus, string> = {
  running: tr("tasks.running"),
  idle: tr("tasks.idle"),
  waiting_permission: tr("status.waiting_permission"),
  stopped: tr("status.stopped"),
  error: tr("status.error"),
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nodes, setNodes] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<TaskStatus | "">("");
  const [error, setError] = useState<string | null>(null);

  // Only the latest request may write: an older, slower response must not overwrite a newer filter's result.
  const seq = useRef(0);
  const load = () => {
    const id = ++seq.current;
    api
      .tasks(filter || undefined)
      .then((list) => {
        if (id === seq.current) setTasks(list);
      })
      .catch((err: unknown) => {
        if (id === seq.current) setError(errorText(err));
      });
  };

  useEffect(() => {
    api.tree().then((t: InventoryNode[]) => setNodes(new Map(t.map((n) => [n.id, n.name])))).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return subscribeEvents((ev) => {
      if (ev.type === "task.status" || ev.type === "resync") load();
    });
  }, [filter]);

  const waiting = tasks.filter((t) => t.status === "waiting_permission");
  const rest = tasks.filter((t) => t.status !== "waiting_permission");

  const stop = (id: string) => api.stopTask(id).then(load).catch((err: unknown) => setError(errorText(err)));

  const row = (t: Task) => (
    <tr key={t.id} className="border-t border-border/60 hover:bg-muted/40">
      <td className="py-2 pr-3">
        <Link className="font-medium hover:text-primary" to={`/nodes/${t.nodeId}/tasks/${t.id}`}>
          {t.title}
        </Link>
      </td>
      <td className="pr-3">{nodes.get(t.nodeId) ?? t.nodeId}</td>
      <td className="pr-3">{STATUS_LABEL[t.status]}</td>
      <td className="pr-3 text-muted-foreground">{fmtDateTime(t.createdAt)}</td>
      <td>
        {t.status === "running" || t.status === "waiting_permission" ? (
          <button className="text-destructive underline" onClick={() => stop(t.id)}>
            {tr("common.stop")}
          </button>
        ) : null}
      </td>
    </tr>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 overflow-y-auto p-6 text-sm">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{tr("tasks.title")}</h1>
        <select className={cn(fieldClass, "w-auto")} value={filter} onChange={(e) => setFilter(e.target.value as TaskStatus | "")}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? tr("tasks.allStatuses") : STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      {waiting.length > 0 && (
        <section>
          <h2 className="mb-1 font-medium text-amber-600 dark:text-amber-400">{tr("tasks.waiting")}</h2>
          <table className="w-full text-left">
            <tbody>{waiting.map(row)}</tbody>
          </table>
        </section>
      )}

      <table className="w-full text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="pr-3">{tr("tasks.task")}</th>
            <th className="pr-3">{tr("tasks.node")}</th>
            <th className="pr-3">{tr("tasks.status")}</th>
            <th className="pr-3">{tr("tasks.created")}</th>
            <th />
          </tr>
        </thead>
        <tbody>{rest.map(row)}</tbody>
      </table>
    </div>
  );
}
