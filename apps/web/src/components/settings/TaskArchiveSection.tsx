import { useEffect, useState, type FormEvent } from "react";
import { ArchiveRestore } from "lucide-react";
import type { Task } from "@sysadm/shared";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDate, fmtDateTime } from "@/i18n";
import { t } from "@/i18n/settings";
import { errorText } from "@/lib/utils";

// Tasks are never deleted by hand (audit); archived ones are purged by the server after N days.
export default function TaskArchiveSection() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [days, setDays] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    api.archivedTasks().then(setTasks).catch((err: unknown) => setMessage(errorText(err)));
  };
  useEffect(() => {
    load();
    api.taskRetention().then((r) => setDays(String(r.days))).catch(() => {});
  }, []);

  const saveDays = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.setTaskRetention(Number(days));
      setDays(String(r.days));
      setMessage(t("common.saved"));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const restore = async (id: string) => {
    try {
      await api.unarchiveTask(id);
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={saveDays} className="flex items-end gap-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("tasks.retention")}</span>
          <Input type="number" min={1} max={3650} required value={days} onChange={(e) => setDays(e.target.value)} className="w-32" />
        </label>
        <Button type="submit" variant="outline">
          {t("common.save")}
        </Button>
        {message && <span className="pb-1.5 text-xs text-muted-foreground">{message}</span>}
      </form>
      <p className="text-xs text-muted-foreground">{t("tasks.intro")}</p>
      <ul className="divide-y divide-border rounded-xl border">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate">{task.title}</div>
              <div className="text-xs text-muted-foreground">
                {t("tasks.created", { date: fmtDateTime(task.createdAt) })}
                {task.archivedAt ? ` · ${t("tasks.archivedSince", { date: fmtDate(task.archivedAt) })}` : ""}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void restore(task.id)}>
              <ArchiveRestore /> {t("tasks.restore")}
            </Button>
          </li>
        ))}
        {tasks.length === 0 && <li className="px-3 py-3 text-muted-foreground">{t("tasks.empty")}</li>}
      </ul>
    </div>
  );
}
