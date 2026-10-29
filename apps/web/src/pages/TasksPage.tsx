import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { InventoryNode, Task, TaskStatus } from "@sysadm/shared";
import { api, subscribeEvents } from "../api";

const STATUSES: Array<TaskStatus | ""> = ["", "running", "waiting_permission", "idle", "stopped", "error"];
const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "выполняется",
  idle: "ожидает",
  waiting_permission: "ждёт подтверждения",
  stopped: "остановлена",
  error: "ошибка",
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nodes, setNodes] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState<TaskStatus | "">("");
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .tasks(filter || undefined)
      .then(setTasks)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));
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

  const stop = (id: string) => api.stopTask(id).then(load).catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));

  const row = (t: Task) => (
    <tr key={t.id} className="border-t">
      <td className="py-1 pr-3">
        <Link className="underline" to={`/tasks/${t.id}`}>
          {t.title}
        </Link>
      </td>
      <td className="pr-3">{nodes.get(t.nodeId) ?? t.nodeId}</td>
      <td className="pr-3">{STATUS_LABEL[t.status]}</td>
      <td className="pr-3 text-neutral-500">{new Date(t.createdAt).toLocaleString()}</td>
      <td>
        {t.status === "running" || t.status === "waiting_permission" ? (
          <button className="text-red-700 underline" onClick={() => stop(t.id)}>
            Стоп
          </button>
        ) : null}
      </td>
    </tr>
  );

  return (
    <div className="max-w-4xl space-y-4 p-4 text-sm">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Задачи</h1>
        <select className="rounded border px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value as TaskStatus | "")}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "все статусы" : STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </header>

      {error && <p className="text-red-600">{error}</p>}

      {waiting.length > 0 && (
        <section>
          <h2 className="mb-1 font-medium text-amber-700">Ждут подтверждения</h2>
          <table className="w-full text-left">
            <tbody>{waiting.map(row)}</tbody>
          </table>
        </section>
      )}

      <table className="w-full text-left">
        <thead className="text-xs text-neutral-500">
          <tr>
            <th className="pr-3">Задача</th>
            <th className="pr-3">Узел</th>
            <th className="pr-3">Статус</th>
            <th className="pr-3">Создана</th>
            <th />
          </tr>
        </thead>
        <tbody>{rest.map(row)}</tbody>
      </table>
    </div>
  );
}
