import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Puzzle } from "lucide-react";
import { api, type PluginInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/settings";
import { errorText } from "@/lib/utils";
import { WEB_PLUGINS } from "@/plugins";

// Notifies the sidebar, which lists enabled plugin pages.
export const PLUGINS_CHANGED = "sysadm:plugins-changed";

export default function PluginsSection() {
  const [list, setList] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.plugins().then(setList).catch((err: unknown) => setError(errorText(err)));
  }, []);

  const toggle = async (p: PluginInfo) => {
    if (p.enabled && !window.confirm(t("plugins.confirmDisable", { name: p.name }))) return;
    try {
      const next = await api.setPluginEnabled(p.id, !p.enabled);
      setList((l) => l.map((x) => (x.id === p.id ? next : x)));
      window.dispatchEvent(new Event(PLUGINS_CHANGED));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("plugins.intro")}</p>
      {error && <p className="text-destructive">{error}</p>}
      <ul className="divide-y divide-border rounded-xl border">
        {list.map((p) => {
          const web = WEB_PLUGINS.find((w) => w.id === p.id);
          const Icon = web?.icon ?? Puzzle;
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <Icon className="size-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.id}</span>
                  {p.enabled && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{t("plugins.enabled")}</span>}
                </div>
                <p className="text-xs text-muted-foreground">{p.description}</p>
              </div>
              {p.enabled && web?.Page && (
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/plugins/${p.id}`}>{t("common.open")}</Link>
                </Button>
              )}
              <Button variant={p.enabled ? "outline" : "default"} size="sm" onClick={() => void toggle(p)}>
                {p.enabled ? t("plugins.disable") : t("plugins.enable")}
              </Button>
            </li>
          );
        })}
        {list.length === 0 && !error && <li className="px-3 py-3 text-muted-foreground">{t("plugins.none")}</li>}
      </ul>
    </div>
  );
}
