import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Plus, Server, Trash2 } from "lucide-react";
import { api, type IntegrationInfo, type ProviderConfig } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { useOverlay } from "./useOverlay";

// opencode's own gateway goes first: it is the key most installs need.
const FIRST = ["opencode", "anthropic", "openai", "openrouter"];
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const PACKAGES: Array<[string, string]> = [
  ["@opencode/ai/providers/openai-compatible", t("providers.pkgOpenAi")],
  ["@opencode/ai/providers/openai-compatible/responses", t("providers.pkgOpenAiResponses")],
  ["@opencode/ai/providers/anthropic-compatible", t("providers.pkgAnthropic")],
];

// Ollama, LM Studio and vLLM are built into opencode with model discovery: only the address is set.
const PRESETS: Array<{ label: string; id: string; baseURL: string; discovery: boolean }> = [
  { label: "llama.cpp", id: "llamacpp", baseURL: "http://10.0.0.10:8080/v1", discovery: false },
  { label: "Ollama", id: "ollama", baseURL: "http://10.0.0.10:11434/v1", discovery: true },
  { label: "LM Studio", id: "lmstudio", baseURL: "http://10.0.0.10:1234/v1", discovery: true },
  { label: "vLLM", id: "vllm", baseURL: "http://10.0.0.10:8000/v1", discovery: true },
  { label: t("providers.customGateway"), id: "gateway", baseURL: "https://llm.example.com/v1", discovery: false },
];

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
  discovery: boolean;
  models: ModelRow[];
}

const emptyDraft: Draft = { id: "", name: "", package: PACKAGES[0][0], baseURL: "", discovery: false, models: [{ id: "", name: "", context: "" }] };

function toDraft(id: string, p: ProviderConfig): Draft {
  const models = Object.entries(p.models ?? {}).map(([mid, m]) => ({ id: mid, name: m.name ?? "", context: m.limit?.context ? String(m.limit.context) : "" }));
  return {
    id,
    name: p.name ?? "",
    package: p.package ?? "",
    baseURL: typeof p.settings?.baseURL === "string" ? p.settings.baseURL : "",
    discovery: !p.package,
    models: models.length ? models : [{ id: "", name: "", context: "" }],
  };
}

// Keeps fields the form does not show (headers, body, compatibility...) that the admin set in the raw config.
function fromDraft(d: Draft, previous: ProviderConfig | undefined): ProviderConfig {
  const next: ProviderConfig = { ...previous, settings: { ...previous?.settings, baseURL: d.baseURL.trim() } };
  if (d.name.trim()) next.name = d.name.trim();
  else delete next.name;
  if (d.discovery) {
    delete next.package;
    delete next.models;
    return next;
  }
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

function CustomProviders({ integrations, onChanged }: { integrations: IntegrationInfo[]; onChanged: () => void }) {
  const { overlay, error, update } = useOverlay();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const providers = overlay?.providers ?? {};

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const id = draft.id.trim();
    if (!PROVIDER_ID.test(id)) return setMessage(t("common.idRule"));
    if (!/^https?:\/\/\S+$/.test(draft.baseURL.trim())) return setMessage(t("providers.urlRule"));
    if (!draft.discovery && !draft.models.some((m) => m.id.trim())) return setMessage(t("providers.needModel"));
    try {
      await update((o) => {
        const all = { ...o.providers };
        if (editing && editing !== id) delete all[editing];
        all[id] = fromDraft(draft, o.providers?.[editing ?? id]);
        return { ...o, providers: all };
      });
      setDraft(null);
      setEditing(null);
      setMessage(t("providers.saved", { id }));
      onChanged();
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
      onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const setModel = (i: number, patch: Partial<ModelRow>) =>
    draft && setDraft({ ...draft, models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{t("providers.customTitle")}</h3>
        <span className="text-xs text-muted-foreground">{t("providers.customHint")}</span>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      <ul className="divide-y divide-border rounded-xl border">
        {Object.entries(providers).map(([id, p]) => {
          const connected = integrations.find((i) => i.id === id)?.connections.length;
          return (
            <li key={id} className="flex items-center gap-3 px-3 py-2">
              <Server className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name || id}</span>
                  <span className="text-xs text-muted-foreground">{id}</span>
                  {connected ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{t("providers.keySet")}</span> : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {typeof p.settings?.baseURL === "string" ? p.settings.baseURL : t("providers.defaultAddress")} ·{" "}
                  {p.package ? t("providers.modelsCount", { count: Object.keys(p.models ?? {}).length }) : t("providers.discovered")}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => {
                  setEditing(id);
                  setDraft(toDraft(id, p));
                  setMessage(null);
                }}>
                {t("common.edit")}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("common.delete")} onClick={() => void remove(id)}>
                <Trash2 />
              </Button>
            </li>
          );
        })}
        {Object.keys(providers).length === 0 && <li className="px-3 py-3 text-muted-foreground">{t("providers.noCustom")}</li>}
      </ul>

      {!draft && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("providers.addPrefix")}</span>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null);
                setMessage(null);
                setDraft({ ...emptyDraft, id: p.id, name: p.label, baseURL: p.baseURL, discovery: p.discovery });
              }}
            >
              <Plus /> {p.label}
            </Button>
          ))}
        </div>
      )}

      {draft && (
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
            <label className="col-span-2 flex items-center gap-2">
              <input type="checkbox" checked={draft.discovery} onChange={(e) => setDraft({ ...draft, discovery: e.target.checked })} />
              <span>{t("providers.discoveryHint")}</span>
            </label>
            {!draft.discovery && (
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
            )}
          </div>
          {!draft.discovery && (
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
          )}
          <div className="flex gap-2">
            <Button type="submit">{t("providers.saveProvider")}</Button>
            <Button type="button" variant="ghost" onClick={() => {
                setDraft(null);
                setEditing(null);
              }}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </section>
  );
}

export default function ProvidersSection() {
  const [list, setList] = useState<IntegrationInfo[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    api
      .integrations()
      .then((r) => setList(r.data.filter((i) => i.methods.some((m) => m.type === "key"))))
      .catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (i: IntegrationInfo) => (i.connections.length > 0 ? -100 : 0) + (FIRST.includes(i.id) ? FIRST.indexOf(i.id) - 50 : 0);
    return list
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [list, query]);

  // The key goes to opencode once and is cleared; it is never stored in the browser or in sysadm.
  const save = async (e: FormEvent, id: string) => {
    e.preventDefault();
    try {
      await api.setProviderKey(id, key);
      setKey("");
      setEditing(null);
      setMessage(t("providers.keySaved"));
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <div className="space-y-6">
      <CustomProviders integrations={list} onChanged={() => setTimeout(load, 1500)} />
      <section className="space-y-3">
        <div>
          <h3 className="font-medium">{t("providers.keysTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("providers.keysHint")}</p>
        </div>
        <Input placeholder={t("providers.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        <ul className="divide-y divide-border rounded-xl border">
          {shown.map((i) => (
            <li key={i.id} className={cn("px-3 py-2", editing === i.id && "bg-accent/40")}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{i.name}</span>
                <span className="text-xs text-muted-foreground">{i.id}</span>
                {i.connections.length > 0 && (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">
                    <Check className="size-3" /> {t("providers.connected")}
                  </span>
                )}
                <button
                  className="ml-auto text-xs text-primary hover:underline"
                  onClick={() => {
                    setEditing(editing === i.id ? null : i.id);
                    setKey("");
                  }}
                >
                  {editing === i.id ? t("common.cancel") : i.connections.length > 0 ? t("providers.replaceKey") : t("providers.enterKey")}
                </button>
              </div>
              {editing === i.id && (
                <form onSubmit={(e) => save(e, i.id)} className="mt-2 flex gap-2">
                  <Input autoFocus type="password" autoComplete="off" placeholder={t("providers.keyPlaceholder", { name: i.name })} value={key} onChange={(e) => setKey(e.target.value)} />
                  <Button disabled={!key}>{t("common.save")}</Button>
                </form>
              )}
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-4 text-center text-muted-foreground">{t("providers.noProviders")}</li>}
        </ul>
      </section>
    </div>
  );
}
