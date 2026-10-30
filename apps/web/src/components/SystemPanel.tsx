import { useEffect, useState } from "react";
import { api, type LogEntry, type OpencodeVersion, type SystemHealth } from "../api";
import { OPENCODE_CHECKED } from "./OpencodeUpdate";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { fmtTime } from "@/i18n";
import { t } from "@/i18n/settings";

const HEALTH_REFRESH_MS = 10_000;
const buttonClass = "h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50";
const selectClass = cn(fieldClass, "w-auto");

function HealthCard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<OpencodeVersion | null>(null);

  useEffect(() => {
    api.opencodeVersion().then(setVersion, () => {});
  }, []);

  const checkUpdates = () =>
    api
      .opencodeVersion(true)
      .then((v) => {
        setVersion(v);
        window.dispatchEvent(new Event(OPENCODE_CHECKED));
        setMessage(v.error ?? (v.updateAvailable ? t("system.updateFound", { latest: v.latest ?? "" }) : t("system.upToDate")));
      })
      .catch((err: unknown) => setMessage(errorText(err)));

  const load = () => api.systemHealth().then(setHealth).catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
    const timer = setInterval(load, HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const restart = () => {
    if (!window.confirm(t("system.confirmRestart"))) return;
    api
      .restartOpencode()
      .then(load)
      .catch((err: unknown) => setMessage(errorText(err)));
  };

  if (!health) return <p className="text-sm text-muted-foreground">{message ?? t("common.loading")}</p>;
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4 text-sm">
      <p>
        {t("system.version")} <span className="font-mono">{health.version}</span>, {t("system.uptime", { minutes: Math.floor(health.uptimeSec / 60) })}
      </p>
      <p>
        opencode: <span className="font-medium">{health.opencode.state}</span>, {t("system.restarts", { restarts: health.opencode.restarts })}
        {health.opencode.lastExitCode !== null && t("system.lastExit", { code: health.opencode.lastExitCode })}
        {version && (
          <>
            , <span className="font-mono">{version.current ?? t("system.notInstalled")}</span>
            {version.mode === "external" && ` (${t("system.external")})`}
          </>
        )}
      </p>
      <p>{t("system.tasks", { running: health.tasks.running, waiting: health.tasks.waiting_permission })}</p>
      <p>{health.db.ok ? t("system.dbOk", { schema: health.db.schemaVersion }) : t("system.dbDown")}</p>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} onClick={restart}>
          {t("system.restart")}
        </button>
        {version?.mode === "managed" && (
          <button className={cn(buttonClass, "bg-secondary text-secondary-foreground hover:bg-secondary/80")} onClick={() => void checkUpdates()}>
            {t("system.checkUpdates")}
          </button>
        )}
      </div>
      {message && <p className="text-muted-foreground">{message}</p>}
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
          <option value="">{t("system.allSources")}</option>
          <option value="app">app</option>
          <option value="opencode">opencode</option>
        </select>
        <select className={selectClass} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">{t("system.allLevels")}</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button className="h-8 rounded-lg border px-3 text-sm hover:bg-muted" onClick={load}>
          {t("common.refresh")}
        </button>
      </div>
      {message && <p className="text-sm text-destructive">{message}</p>}
      <pre className="max-h-96 overflow-auto rounded-xl bg-muted p-3 font-mono text-xs">
        {rows.map((r) => `${fmtTime(r.ts)} [${r.source}] ${r.level} ${r.msg}`).join("\n")}
      </pre>
    </div>
  );
}

export default function SystemPanel() {
  return (
    <div className="space-y-4">
      <HealthCard />
      <LogsCard />
    </div>
  );
}
