import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Check, ChevronRight, Cloud, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { api, type IntegrationInfo, type ModelInfo, type ProviderConfig } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { useOverlay } from "./useOverlay";

// opencode's own gateway goes first: it is the key most installs need.
const FIRST = ["opencode", "opencode-go", "anthropic", "openai", "openrouter"];
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// opencode names both of its gateways "OpenCode…"; spell out which is which and how each is paid.
const OPENCODE: Record<string, { name: string; plan: string }> = {
  opencode: { name: "OpenCode Zen", plan: t("providers.planZen") },
  "opencode-go": { name: "OpenCode Go", plan: t("providers.planGo") },
};

const PACKAGES: Array<[string, string]> = [
  ["@opencode/ai/providers/openai-compatible", t("providers.pkgOpenAi")],
  ["@opencode/ai/providers/openai-compatible/responses", t("providers.pkgOpenAiResponses")],
  ["@opencode/ai/providers/anthropic-compatible", t("providers.pkgAnthropic")],
];

const SWITCH_CLASS =
  "relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/30 transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-background before:shadow before:transition-transform checked:bg-primary checked:before:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

interface ModelRow {
  id: string;
  name: string;
  context: string;
}

interface Draft {
  id: string;
  name: string;
  package: string;
  baseURL: string;
  models: ModelRow[];
}

const emptyDraft: Draft = { id: "", name: "", package: PACKAGES[0][0], baseURL: "", models: [{ id: "", name: "", context: "" }] };

function toDraft(id: string, p: ProviderConfig): Draft {
  const models = Object.entries(p.models ?? {}).map(([mid, m]) => ({ id: mid, name: m.name ?? "", context: m.limit?.context ? String(m.limit.context) : "" }));
  return {
    id,
    name: p.name ?? "",
    package: p.package ?? PACKAGES[0][0],
    baseURL: typeof p.settings?.baseURL === "string" ? p.settings.baseURL : "",
    models: models.length ? models : [{ id: "", name: "", context: "" }],
  };
}

// Keeps fields the form does not show (headers, body, compatibility...) that the admin set in the raw config.
function fromDraft(d: Draft, previous: ProviderConfig | undefined): ProviderConfig {
  const next: ProviderConfig = { ...previous, settings: { ...previous?.settings, baseURL: d.baseURL.trim() } };
  if (d.name.trim()) next.name = d.name.trim();
  else delete next.name;
  next.package = d.package;
  next.models = Object.fromEntries(
    d.models
      .filter((m) => m.id.trim())
      .map((m) => {
        const prev = previous?.models?.[m.id.trim()];
        const ctx = Number(m.context);
        return [m.id.trim(), { ...prev, ...(m.name.trim() ? { name: m.name.trim() } : {}), ...(ctx > 0 ? { limit: { ...prev?.limit, context: ctx } } : {}) }];
      }),
  );
  return next;
}

// The key goes to opencode once and is cleared; it is never stored in the browser or in sysadm.
function KeyForm({ integration, onSaved }: { integration: IntegrationInfo; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setProviderKey(integration.id, key);
      setKey("");
      setMessage(t("providers.keySaved"));
      onSaved();
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <form onSubmit={save} className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="font-medium">{integration.connections.length > 0 ? t("providers.replaceKey") : t("providers.enterKey")}</span>
        {integration.connections.length > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">
            <Check className="size-3" /> {t("providers.connected")}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input type="password" autoComplete="off" placeholder={t("providers.keyPlaceholder", { name: integration.name })} value={key} onChange={(e) => setKey(e.target.value)} />
        <Button disabled={!key}>{t("common.save")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("providers.keysHint")}</p>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </form>
  );
}

function ProviderForm({
  editing,
  initial,
  update,
  onSaved,
}: {
  editing: string | null;
  initial: Draft;
  update: ReturnType<typeof useOverlay>["update"];
  onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const id = draft.id.trim();
    if (!PROVIDER_ID.test(id)) return setMessage(t("common.idRule"));
    if (!/^https?:\/\/\S+$/.test(draft.baseURL.trim())) return setMessage(t("providers.urlRule"));
    if (!draft.models.some((m) => m.id.trim())) return setMessage(t("providers.needModel"));
    try {
      await update((o) => {
        const all = { ...o.providers };
        if (editing && editing !== id) delete all[editing];
        all[id] = fromDraft(draft, o.providers?.[editing ?? id]);
        return { ...o, providers: all };
      });
      setMessage(t("providers.saved", { id }));
      onSaved(id);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const setModel = (i: number, patch: Partial<ModelRow>) => setDraft({ ...draft, models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("providers.idLabel")}</span>
          <Input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("common.displayName")}</span>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-xs text-muted-foreground">{t("providers.baseUrlHint")}</span>
          <Input className="font-mono" value={draft.baseURL} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-xs text-muted-foreground">{t("providers.protocol")}</span>
          <select className={fieldClass} value={draft.package} onChange={(e) => setDraft({ ...draft, package: e.target.value })}>
            {PACKAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_1fr_7rem_2rem] gap-2 text-xs text-muted-foreground">
          <span>{t("providers.modelId")}</span>
          <span>{t("common.displayName")}</span>
          <span>{t("providers.contextTokens")}</span>
        </div>
        {draft.models.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_7rem_2rem] gap-2">
            <Input className="font-mono" placeholder="qwen3-coder" value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} />
            <Input placeholder="Qwen 3 Coder" value={m.name} onChange={(e) => setModel(i, { name: e.target.value })} />
            <Input inputMode="numeric" placeholder="32768" value={m.context} onChange={(e) => setModel(i, { context: e.target.value.replace(/\D/g, "") })} />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("providers.removeModel")}
              onClick={() => setDraft({ ...draft, models: draft.models.filter((_, j) => j !== i) })}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", name: "", context: "" }] })}>
          <Plus /> {t("providers.model")}
        </Button>
      </div>
      <Button type="submit">{t("providers.saveProvider")}</Button>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </form>
  );
}

// Searchable catalog of opencode providers that take an API key.
function Catalog({ list, onSaved }: { list: IntegrationInfo[]; onSaved: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (i: IntegrationInfo) => (i.connections.length > 0 ? -100 : 0) + (FIRST.includes(i.id) ? FIRST.indexOf(i.id) - 50 : 0);
    return list.filter((i) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [list, query]);

  return (
    <section className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("providers.keysHint")}</p>
      <Input autoFocus placeholder={t("providers.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="divide-y divide-border rounded-xl border">
        {shown.map((i) => (
          <li key={i.id} className={cn("px-3 py-2", picked === i.id && "bg-accent/40")}>
            <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setPicked(picked === i.id ? null : i.id)}>
              <span className="font-medium">{OPENCODE[i.id]?.name ?? i.name}</span>
              <span className="text-xs text-muted-foreground">{OPENCODE[i.id]?.plan ?? i.id}</span>
              {i.connections.length > 0 && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">
                  <Check className="size-3" /> {t("providers.connected")}
                </span>
              )}
              <ChevronRight className={cn("ml-auto size-4 text-muted-foreground transition-transform", picked === i.id && "rotate-90")} />
            </button>
            {picked === i.id && (
              <div className="mt-2">
                <KeyForm integration={i} onSaved={onSaved} />
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-4 text-center text-muted-foreground">{t("providers.noProviders")}</li>}
      </ul>
    </section>
  );
}

type View = { kind: "list" } | { kind: "provider"; id: string } | { kind: "new"; draft: Draft } | { kind: "catalog" };

export default function ProvidersSection() {
  const { overlay, error: overlayError, update } = useOverlay();
  const [list, setList] = useState<IntegrationInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [disabled, setDisabled] = useState<string[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [message, setMessage] = useState<string | null>(null);
  const custom = overlay?.providers ?? {};

  const load = () =>
    Promise.all([api.integrations(), api.models(), api.providers()])
      .then(([i, m, p]) => {
        setList(i.data.filter((x) => x.methods.some((k) => k.type === "key")));
        setModels(m.data);
        setNames(Object.fromEntries(p.data.map((x) => [x.id, x.name])));
      })
      .catch((err: unknown) => setMessage(errorText(err)));
  // opencode needs a moment to reload the config before the integration list reflects it.
  const reload = () => setTimeout(load, 1500);
  useEffect(() => {
    load();
    api.disabledProviders().then(setDisabled).catch((err: unknown) => setMessage(errorText(err)));
  }, []);

  // Cards: every provider opencode serves models from (any config: ours, global, env keys, free OpenCode Zen),
  // plus sysadm's own providers, keyed cloud ones and disabled ones (their models leave model.list).
  const cards = useMemo(() => {
    const ids = [
      ...new Set([
        ...Object.keys(custom),
        ...models.map((m) => m.providerID),
        ...list.filter((i) => i.connections.length > 0).map((i) => i.id),
        ...disabled,
      ]),
    ];
    return ids.map((id) => {
      const p = custom[id];
      const integration = list.find((i) => i.id === id);
      const count = models.filter((m) => m.providerID === id).length || Object.keys(p?.models ?? {}).length;
      const where = p ? (typeof p.settings?.baseURL === "string" ? p.settings.baseURL : t("providers.defaultAddress")) : integration?.connections.length ? t("providers.cloudSubtitle") : t("providers.builtinSubtitle");
      const plan = OPENCODE[id] && !p ? `${OPENCODE[id].plan} · ` : "";
      return { id, name: p?.name || OPENCODE[id]?.name || names[id] || integration?.name || id, subtitle: `${plan}${where} · ${t("providers.modelsCount", { count })}`, custom: !!p, keySet: !!integration?.connections.length };
    });
  }, [custom, list, models, names, disabled]);

  const toggle = async (id: string, name: string) => {
    const off = !disabled.includes(id);
    if (off && !window.confirm(t("providers.confirmDisable", { name }))) return;
    try {
      setDisabled(await api.setDisabledProviders(off ? [...disabled, id] : disabled.filter((x) => x !== id)));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("providers.confirmDelete", { id }))) return;
    try {
      await update((o) => {
        const all = { ...o.providers };
        delete all[id];
        return { ...o, providers: all };
      });
      setView({ kind: "list" });
      reload();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  if (view.kind !== "list") {
    const id = view.kind === "provider" ? view.id : null;
    const integration = id ? list.find((i) => i.id === id) : undefined;
    const title = view.kind === "catalog" ? t("providers.keysTitle") : view.kind === "new" ? view.draft.name || t("providers.newProvider") : (cards.find((c) => c.id === id)?.name ?? id);
    return (
      <div className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView({ kind: "list" })}>
            <ArrowLeft /> {t("common.back")}
          </Button>
          <span className="font-medium">{title}</span>
          {id && custom[id] && (
            <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => void remove(id)}>
              <Trash2 /> {t("common.delete")}
            </Button>
          )}
        </div>
        {view.kind === "catalog" && <Catalog list={list} onSaved={reload} />}
        {view.kind === "new" && (
          <ProviderForm
            editing={null}
            initial={view.draft}
            update={update}
            onSaved={(saved) => {
              setView({ kind: "provider", id: saved });
              reload();
            }}
          />
        )}
        {id && custom[id] && (
          <ProviderForm
            key={id}
            editing={id}
            initial={toDraft(id, custom[id])}
            update={update}
            onSaved={(saved) => {
              if (saved !== id) setView({ kind: "provider", id: saved });
              reload();
            }}
          />
        )}
        {integration && <KeyForm integration={integration} onSaved={reload} />}
        {id && !custom[id] && (
          <ul className="divide-y divide-border rounded-xl border">
            {models
              .filter((m) => m.providerID === id)
              .map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="font-medium">{m.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{m.id}</span>
                  {m.limit?.context ? <span className="ml-auto text-xs text-muted-foreground">{m.limit.context.toLocaleString()}</span> : null}
                </li>
              ))}
            {!models.some((m) => m.providerID === id) && <li className="px-3 py-4 text-center text-muted-foreground">{t("providers.noModels")}</li>}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("providers.intro")}</p>
      {overlayError && <p className="text-destructive">{overlayError}</p>}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {cards.map((c) => {
          const on = !disabled.includes(c.id);
          const Icon = c.custom ? Server : Cloud;
          return (
            <div key={c.id} className="flex items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40">
              <button type="button" onClick={() => setView({ kind: "provider", id: c.id })} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left">
                <Icon className={cn("mt-0.5 size-5 shrink-0", on ? "text-primary" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-medium">
                    <span className="truncate">{c.name}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {c.id} · {c.subtitle}
                  </span>
                  {c.keySet && c.custom && <span className="mt-1 inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{t("providers.keySet")}</span>}
                </span>
              </button>
              <input
                type="checkbox"
                role="switch"
                aria-label={on ? t("plugins.disable") : t("plugins.enable")}
                title={on ? t("plugins.disable") : t("plugins.enable")}
                checked={on}
                onChange={() => void toggle(c.id, c.name)}
                className={SWITCH_CLASS}
              />
            </div>
          );
        })}
        {cards.length === 0 && <p className="text-muted-foreground">{t("providers.none")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("providers.addPrefix")}</span>
        <Button variant="outline" size="sm" onClick={() => setView({ kind: "catalog" })}>
          <Cloud /> {t("providers.addCloud")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setView({ kind: "new", draft: emptyDraft })}>
          <Plus /> {t("providers.customGateway")}
        </Button>
      </div>
    </div>
  );
}
