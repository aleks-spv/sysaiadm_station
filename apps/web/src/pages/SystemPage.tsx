import { useEffect, useState } from "react";
import { api, type LogEntry, type SystemHealth } from "../api";

const HEALTH_REFRESH_MS = 10_000;
const buttonClass = "rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50";
const selectClass = "rounded border border-neutral-300 px-2 py-1 text-sm";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Ошибка";
}

function HealthCard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.systemHealth().then(setHealth).catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
    const timer = setInterval(load, HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const restart = () => {
    if (!window.confirm("Перезапустить opencode? Выполняющиеся задачи будут прерваны.")) return;
    api
      .restartOpencode()
      .then(load)
      .catch((err: unknown) => setMessage(errorText(err)));
  };

  if (!health) return <p className="text-sm text-neutral-500">{message ?? "Загрузка…"}</p>;
  return (
    <div className="space-y-2 rounded border p-3 text-sm">
      <p>
        Версия <span className="font-mono">{health.version}</span>, аптайм {Math.floor(health.uptimeSec / 60)} мин
      </p>
      <p>
        opencode: <span className="font-medium">{health.opencode.state}</span>, рестартов {health.opencode.restarts}
        {health.opencode.lastExitCode !== null && `, последний код выхода ${health.opencode.lastExitCode}`}
      </p>
      <p>
        Задачи: выполняются {health.tasks.running}, ждут ответа {health.tasks.waiting_permission}
      </p>
      <p>База данных: {health.db.ok ? `в порядке, схема ${health.db.schemaVersion}` : "недоступна"}</p>
      <button className={buttonClass} onClick={restart}>
        Перезапустить opencode
      </button>
      {message && <p className="text-neutral-600">{message}</p>}
    </div>
  );
}

function LogsCard() {
  const [source, setSource] = useState("");
  const [level, setLevel] = useState("");
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    api
      .systemLogs({ source: source || undefined, level: level || undefined, limit: 200 })
      .then((list) => {
        setRows(list);
        setMessage(null);
      })
      .catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
  }, [source, level]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <select className={selectClass} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">все источники</option>
          <option value="app">app</option>
          <option value="opencode">opencode</option>
        </select>
        <select className={selectClass} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">все уровни</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button className="rounded border px-3 py-1 text-sm" onClick={load}>
          Обновить
        </button>
      </div>
      {message && <p className="text-sm text-red-700">{message}</p>}
      <pre className="max-h-96 overflow-auto rounded bg-neutral-100 p-2 text-xs">
        {rows.map((r) => `${new Date(r.ts).toLocaleTimeString()} [${r.source}] ${r.level} ${r.msg}`).join("\n")}
      </pre>
    </div>
  );
}

export default function SystemPage() {
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Система</h1>
      <HealthCard />
      <LogsCard />
    </div>
  );
}
