import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Bot, Plus, Star } from "lucide-react";
import { api, type AgentConfig, type AgentInfo, type ModelInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { useOverlay } from "./useOverlay";

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODES: Array<[NonNullable<AgentConfig["mode"]>, string]> = [
  ["primary", t("agents.modePrimary")],
  ["subagent", t("agents.modeSubagent")],
  ["all", t("agents.modeAll")],
];

interface Draft {
  id: string;
  description: string;
  mode: NonNullable<AgentConfig["mode"]>;
  model: string; // provider/model, "" = model of the session
  variant: string;
  temperature: string;
  steps: string;
  color: string;
  system: string;
  disabled: boolean;
  hidden: boolean;
}

// The overlay accepts "provider/model#variant" or the expanded object; the form works with the string parts.
function splitModel(model: unknown): { model: string; variant: string } {
  if (typeof model === "string") {
    const [ref, variant = ""] = model.split("#");
    return { model: ref, variant };
  }
  if (model && typeof model === "object" && "providerID" in model && "model" in model) {
    const m = model as { providerID: string; model: string; variant?: string };
    return { model: `${m.providerID}/${m.model}`, variant: m.variant ?? "" };
  }
  return { model: "", variant: "" };
}

function toDraft(id: string, cfg: AgentConfig | undefined, live: AgentInfo | undefined): Draft {
  const { model, variant } = splitModel(cfg?.model ?? (live?.model ? `${live.model.providerID}/${live.model.id}` : ""));
  const temperature = cfg?.request?.body?.temperature;
  return {
    id,
    description: cfg?.description ?? live?.description ?? "",
    mode: cfg?.mode ?? live?.mode ?? "primary",
    model,
    variant,
    temperature: typeof temperature === "number" ? String(temperature) : "",
    steps: cfg?.steps ? String(cfg.steps) : "",
    color: cfg?.color ?? "",
    system: cfg?.system ?? "",
    disabled: cfg?.disabled ?? false,
    hidden: cfg?.hidden ?? false,
  };
}

// Unknown keys the admin set in the raw config (headers, extra body fields) survive a form save.
function fromDraft(d: Draft, prev: AgentConfig | undefined): AgentConfig {
  const next: AgentConfig = { ...prev, mode: d.mode };
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K] | undefined) => {
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  };
  set("description", d.description.trim());
  set("model", d.model ? `${d.model}${d.variant ? `#${d.variant}` : ""}` : undefined);
  set("system", d.system);
  set("color", d.color);
  set("steps", Number(d.steps) > 0 ? Number(d.steps) : undefined);
  set("disabled", d.disabled || undefined);
  set("hidden", d.hidden || undefined);
  const body = { ...prev?.request?.body };
  if (d.temperature.trim() === "") delete body.temperature;
  else body.temperature = Number(d.temperature);
  const request: NonNullable<AgentConfig["request"]> = { ...prev?.request };
  if (Object.keys(body).length > 0) request.body = body;
  else delete request.body;
  set("request", Object.keys(request).length ? request : undefined);
  return next;
}

export default function AgentsSection() {
  const { overlay, error, update } = useOverlay();
  const [live, setLive] = useState<AgentInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadLive = () =>
    api
      .agents()
      .then((r) => setLive(r.data.filter((a) => !["compaction", "title", "summary"].includes(a.id))))
      .catch(() => {});
  useEffect(() => {
    loadLive();
    Promise.all([api.models(), api.hiddenModels().catch(() => [] as string[])])
      .then(([m, h]) => {
        const hidden = new Set(h);
        setModels(m.data.filter((x) => x.enabled !== false && !hidden.has(`${x.providerID}/${x.id}`)));
      })
      .catch(() => {});
  }, []);

  const configured = overlay?.agents ?? {};
  const ids = useMemo(() => [...new Set([...Object.keys(configured), ...live.map((a) => a.id)])].sort(), [configured, live]);
  const defaultAgent = overlay?.default_agent;
  const selectedModel = models.find((m) => `${m.providerID}/${m.id}` === draft?.model);

  const open = (id: string) => {
    setIsNew(false);
    setMessage(null);
    setDraft(toDraft(id, configured[id], live.find((a) => a.id === id)));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (!AGENT_ID.test(draft.id)) return setMessage(t("common.idRule"));
    if (isNew && ids.includes(draft.id)) return setMessage(t("agents.idExists"));
    const temp = draft.temperature.trim();
    if (temp !== "" && !(Number(temp) >= 0 && Number(temp) <= 2)) return setMessage(t("agents.tempRange"));
    try {
      await update((o) => ({ ...o, agents: { ...o.agents, [draft.id]: fromDraft(draft, o.agents?.[draft.id]) } }));
      setIsNew(false);
      setMessage(t("agents.saved"));
      setTimeout(loadLive, 1500);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  // Removing the entry brings a built-in agent back to its defaults and deletes a custom one.
  const reset = async (id: string) => {
    const builtin = ["build", "plan", "general", "explore"].includes(id);
    if (!window.confirm(builtin ? t("agents.confirmReset", { id }) : t("agents.confirmDelete", { id }))) return;
    try {
      await update((o) => {
        const agents = { ...o.agents };
        delete agents[id];
        return { ...o, agents };
      });
      setDraft(null);
      setTimeout(loadLive, 1500);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const makeDefault = (id: string) => update((o) => ({ ...o, default_agent: id })).catch((err: unknown) => setMessage(errorText(err)));

  return (
    <div className="grid grid-cols-[16rem_1fr] gap-4">
      <aside className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            setIsNew(true);
            setMessage(null);
            setDraft(toDraft("", { mode: "primary" }, undefined));
          }}
        >
          <Plus /> {t("agents.new")}
        </Button>
        {error && <p className="text-destructive">{error}</p>}
        <ul className="space-y-0.5">
          {ids.map((id) => {
            const cfg = configured[id];
            const info = live.find((a) => a.id === id);
            return (
              <li key={id}>
                <button
                  onClick={() => open(id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60",
                    draft?.id === id && !isNew && "bg-accent",
                    cfg?.disabled && "opacity-50",
                  )}
                >
                  <Bot className="size-4 shrink-0" style={cfg?.color ? { color: cfg.color } : undefined} />
                  <span className="min-w-0 flex-1 truncate">{id}</span>
                  {defaultAgent === id && <Star className="size-3.5 text-amber-400" />}
                  <span className="text-[10px] text-muted-foreground">{cfg?.disabled ? t("agents.off") : (cfg?.mode ?? info?.mode) === "subagent" ? t("agents.subShort") : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {draft ? (
        <form onSubmit={save} className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">id</span>
              <Input value={draft.id} disabled={!isNew} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.mode")}</span>
              <select className={fieldClass} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft["mode"] })}>
                {MODES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.description")}</span>
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.model")}</span>
              <select className={fieldClass} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value, variant: "" })}>
                <option value="">{t("agents.modelDefault")}</option>
                {draft.model && !selectedModel && <option value={draft.model}>{draft.model}</option>}
                {models.map((m) => (
                  <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                    {m.providerID} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.thinking")}</span>
              <select
                className={fieldClass}
                value={draft.variant}
                disabled={!draft.model}
                onChange={(e) => setDraft({ ...draft, variant: e.target.value })}
              >
                <option value="">{t("common.default")}</option>
                {draft.variant && !selectedModel?.variants?.some((v) => v.id === draft.variant) && <option value={draft.variant}>{draft.variant}</option>}
                {selectedModel?.variants?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.temperature")}</span>
              <Input inputMode="decimal" placeholder="0.2" value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: e.target.value.replace(",", ".") })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.maxSteps")}</span>
              <Input inputMode="numeric" value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t("agents.color")}</span>
              <div className="flex gap-2">
                <input
                  type="color"
                  className="h-8 w-10 rounded-md border bg-transparent"
                  value={draft.color || "#888888"}
                  onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                />
                <Input value={draft.color} placeholder="#4f9d69" onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
              </div>
            </label>
            <div className="flex flex-col justify-end gap-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.disabled} onChange={(e) => setDraft({ ...draft, disabled: e.target.checked })} /> {t("agents.disabledFlag")}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.hidden} onChange={(e) => setDraft({ ...draft, hidden: e.target.checked })} /> {t("agents.hiddenFlag")}
              </label>
            </div>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("agents.systemPrompt")}</span>
            <textarea
              className={cn(fieldClass, "min-h-72 font-mono text-xs leading-relaxed")}
              value={draft.system}
              onChange={(e) => setDraft({ ...draft, system: e.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("agents.note")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{isNew ? t("agents.create") : t("common.save")}</Button>
            {!isNew && defaultAgent !== draft.id && (
              <Button type="button" variant="outline" onClick={() => void makeDefault(draft.id)}>
                <Star /> {t("agents.makeDefault")}
              </Button>
            )}
            {!isNew && configured[draft.id] && (
              <Button type="button" variant="destructive" onClick={() => void reset(draft.id)}>
                {["build", "plan", "general", "explore"].includes(draft.id) ? t("agents.reset") : t("common.delete")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              {t("common.close")}
            </Button>
          </div>
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </form>
      ) : (
        <div className="grid place-items-center rounded-xl border border-dashed p-8 text-center text-muted-foreground">
          <p>
            {t("agents.emptyHint")}
            <br />
            {t("agents.roles")}
          </p>
          {message && <p className="mt-2 text-xs">{message}</p>}
        </div>
      )}
    </div>
  );
}
