import { useEffect, useState, type FormEvent } from "react";
import type { InventoryNode } from "@sysadm/shared";
import { api, type AgentInfo, type ModelInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, errorText, fieldClass } from "@/lib/utils";
import type { Job, JobInput, Schedule } from "./types";
import { t } from "./i18n";

type Kind = Schedule["kind"];

const KINDS: Array<{ key: Kind; label: string }> = [
  { key: "once", label: t("kind.once") },
  { key: "daily", label: t("kind.daily") },
  { key: "weekly", label: t("kind.weekly") },
  { key: "monthly", label: t("kind.monthly") },
];

// Monday first; the values are the contract's days (0 = Sunday).
const WEEKDAYS = [
  { day: 1, label: t("weekday.mon") },
  { day: 2, label: t("weekday.tue") },
  { day: 3, label: t("weekday.wed") },
  { day: 4, label: t("weekday.thu") },
  { day: 5, label: t("weekday.fri") },
  { day: 6, label: t("weekday.sat") },
  { day: 0, label: t("weekday.sun") },
];

const pad = (n: number) => String(n).padStart(2, "0");

// "YYYY-MM-DDTHH:MM" in local time, the value format of <input type="datetime-local">.
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Now + 1 hour, rounded up to the next 5 minutes.
function defaultAt(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  return toLocalInput(d);
}

interface Props {
  node: InventoryNode;
  onClose: () => void;
  job?: Job;
}

export default function ScheduleDialog({ node, onClose, job }: Props) {
  const s = job?.schedule;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agent, setAgent] = useState(job?.agent ?? "");
  const [model, setModel] = useState(job?.model ? `${job.model.providerID}/${job.model.modelID}` : "");
  const [title, setTitle] = useState(job?.title ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [kind, setKind] = useState<Kind>(s?.kind ?? "once");
  const [at, setAt] = useState(s?.kind === "once" ? toLocalInput(new Date(s.at)) : defaultAt());
  const [time, setTime] = useState(s && s.kind !== "once" ? s.time : "03:00");
  const [days, setDays] = useState<number[]>(s?.kind === "weekly" ? s.days : [1]);
  const [day, setDay] = useState(s?.kind === "monthly" ? s.day : 1);
  const [autopilot, setAutopilot] = useState(job?.autopilot ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.agents(), api.models(), api.hiddenModels()])
      .then(([a, m, hidden]) => {
        setAgents(a.data.filter((x) => !x.hidden && x.mode !== "subagent"));
        setModels(m.data.filter((x) => x.enabled !== false && !hidden.includes(`${x.providerID}/${x.id}`)));
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const validate = (): string | null => {
    if (!prompt.trim()) return t("validation.promptRequired");
    if (kind === "once" && !(new Date(at).getTime() > Date.now())) return t("validation.timeInFuture");
    if (kind === "weekly" && days.length === 0) return t("validation.weekdayRequired");
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const text = prompt.trim();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let schedule: Schedule;
    if (kind === "once") schedule = { kind, at: new Date(at).getTime() };
    else if (kind === "daily") schedule = { kind, time, tz };
    else if (kind === "weekly") schedule = { kind, time, days: [...days].sort(), tz };
    else schedule = { kind, time, day, tz };

    // Split at the first "/" so a model id that itself contains a slash survives.
    const slash = model.indexOf("/");
    const input: JobInput = {
      nodeId: node.id,
      title: title.trim() || text.slice(0, 60),
      prompt: text,
      agent: agent || null,
      model: model ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : null,
      schedule,
      autopilot,
    };

    setBusy(true);
    setError(null);
    try {
      if (job) await api.plugin<Job>("scheduler", "PUT", `/jobs/${job.id}`, input);
      else await api.plugin<Job>("scheduler", "POST", "/jobs", input);
      onClose();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{job ? t("title.edit") : t("title.create")}</DialogTitle>
            <DialogDescription>{node.name}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {t("field.agent")}
              <select className={fieldClass} value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">{t("agent.default")}</option>
                {agent && !agents.some((a) => a.id === agent) && <option value={agent}>{agent}</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {t("field.model")}
              <select className={fieldClass} value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{t("model.default")}</option>
                {model && !models.some((m) => `${m.providerID}/${m.id}` === model) && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                    {m.name} ({m.providerID})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="grid gap-1.5 text-xs text-muted-foreground">
            {t("field.name")}
            <Input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("field.namePlaceholder")} />
          </label>

          <label className="grid gap-1.5 text-xs text-muted-foreground">
            {t("field.task")}
            <Textarea
              required
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("field.taskPlaceholder")}
            />
          </label>

          <div className="grid gap-2 text-xs text-muted-foreground">
            <span>{t("field.when")}</span>
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setKind(k.key)}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${kind === k.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {kind === "once" && (
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {t("field.datetime")}
              <Input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
          )}

          {kind !== "once" && (
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {t("field.time")}
              <Input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          )}

          {kind === "weekly" && (
            <div className="flex gap-1">
              {WEEKDAYS.map((w) => {
                const on = days.includes(w.day);
                return (
                  <button
                    key={w.day}
                    type="button"
                    onClick={() => setDays(on ? days.filter((d) => d !== w.day) : [...days, w.day])}
                    className={cn(
                      "h-7 w-9 rounded-lg border text-xs transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
          )}

          {kind === "monthly" && (
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              {t("field.dayOfMonth")}
              <Input type="number" min={1} max={28} required value={day} onChange={(e) => setDay(Number(e.target.value))} />
            </label>
          )}

          <div className="grid gap-1.5">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={autopilot}
                onChange={(e) => setAutopilot(e.target.checked)}
                className="size-3.5 rounded border-border"
              />
              {t("autopilot.label")}
            </label>
            <p className="text-xs text-muted-foreground">{t("autopilot.hint")}</p>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("skipHint")}
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("dialog.cancel")}
            </Button>
            <Button disabled={busy}>{job ? t("dialog.save") : t("dialog.schedule")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
