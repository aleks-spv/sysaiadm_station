import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { api, type ModelInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { cn, errorText } from "@/lib/utils";

const ref = (m: ModelInfo) => `${m.providerID}/${m.id}`;
const COLLAPSED_KEY = "sysadm.settingsModelGroupsCollapsed";

function loadCollapsed(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Hiding only trims the pickers in sysadm; the model stays available to opencode and to agents that name it.
export default function ModelsSection() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [onlyVisible, setOnlyVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const toggleGroup = (provider: string) => {
    const next = collapsed.includes(provider) ? collapsed.filter((p) => p !== provider) : [...collapsed, provider];
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    Promise.all([api.models(), api.hiddenModels()])
      .then(([m, h]) => {
        setModels(m.data.filter((x) => x.enabled !== false));
        setHidden(new Set(h));
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const save = (next: Set<string>) => {
    const previous = hidden;
    setHidden(next);
    api.setHiddenModels([...next]).catch((err: unknown) => {
      setHidden(previous);
      setError(errorText(err));
    });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (q && !`${m.name} ${ref(m)}`.toLowerCase().includes(q)) continue;
      if (onlyVisible && hidden.has(ref(m))) continue;
      map.set(m.providerID, [...(map.get(m.providerID) ?? []), m]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, query, onlyVisible, hidden]);

  const setGroup = (list: ModelInfo[], hide: boolean) => {
    const next = new Set(hidden);
    for (const m of list) {
      if (hide) next.add(ref(m));
      else next.delete(ref(m));
    }
    save(next);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("models.intro")}</p>
      <div className="flex items-center gap-3">
        <Input placeholder={t("models.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input type="checkbox" checked={onlyVisible} onChange={(e) => setOnlyVisible(e.target.checked)} /> {t("models.onlyVisible")}
        </label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("models.hiddenCount", { hidden: hidden.size, total: models.length })}
        </span>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {groups.map(([provider, list]) => {
        // A search shows every match, so collapsed groups open while the query is set.
        const shut = !query.trim() && collapsed.includes(provider);
        return (
          <section key={provider} className="rounded-xl border">
            <header className={cn("flex items-center gap-2 px-3 py-1.5", !shut && "border-b")}>
              <button type="button" aria-expanded={!shut} className="flex min-w-0 items-center gap-1 font-medium hover:text-primary" onClick={() => toggleGroup(provider)}>
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", shut && "-rotate-90")} />
                <span className="truncate">{provider}</span>
              </button>
              <span className="text-xs text-muted-foreground">{list.length}</span>
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setGroup(list, false)}>
                {t("models.showAll")}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setGroup(list, true)}>
                {t("models.hideAll")}
              </Button>
            </header>
            {!shut && <ul className="divide-y divide-border">
              {list.map((m) => {
                const isHidden = hidden.has(ref(m));
                return (
                  <li key={ref(m)} className={cn("flex items-center gap-3 px-3 py-1.5", isHidden && "opacity-50")}>
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{m.id}</span>
                    {m.limit?.context ? <span className="w-16 text-right text-xs text-muted-foreground">{Math.round(m.limit.context / 1000)}k</span> : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={isHidden ? t("common.show") : t("common.hide")}
                      title={isHidden ? t("models.showInLists") : t("models.hideFromLists")}
                      onClick={() => {
                        const next = new Set(hidden);
                        if (isHidden) next.delete(ref(m));
                        else next.add(ref(m));
                        save(next);
                      }}
                    >
                      {isHidden ? <EyeOff /> : <Eye />}
                    </Button>
                  </li>
                );
              })}
            </ul>}
          </section>
        );
      })}
      {groups.length === 0 && !error && <p className="py-6 text-center text-muted-foreground">{t("models.empty")}</p>}
    </div>
  );
}
