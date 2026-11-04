import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Puzzle } from "lucide-react";
import { api, type PluginInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/settings";
import { cn, errorText } from "@/lib/utils";
import { WEB_PLUGINS } from "@/plugins";

// Notifies the sidebar, which lists enabled plugin pages.
export const PLUGINS_CHANGED = "sysadm:plugins-changed";

const KNOWN = ["rtk", "wireguard", "secrets", "terminal", "scheduler"] as const;
type Known = (typeof KNOWN)[number];
const isKnown = (id: string): id is Known => (KNOWN as readonly string[]).includes(id);
// Manifest text comes from the server in Russian; known plugins are translated here, unknown ones show as sent.
const pluginName = (p: PluginInfo) => (isKnown(p.id) ? t(`plugins.${p.id}.name`) : p.name);
const pluginDescription = (p: PluginInfo) => (isKnown(p.id) ? t(`plugins.${p.id}.description`) : p.description);

export default function PluginsSection() {
  const [list, setList] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Plugin whose page is open inside the dialog.
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.plugins().then(setList).catch((err: unknown) => setError(errorText(err)));
  }, []);

  const toggle = async (p: PluginInfo) => {
    if (p.enabled && !window.confirm(t("plugins.confirmDisable", { name: pluginName(p) }))) return;
    try {
      const next = await api.setPluginEnabled(p.id, !p.enabled);
      setList((l) => l.map((x) => (x.id === p.id ? next : x)));
      window.dispatchEvent(new Event(PLUGINS_CHANGED));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const current = list.find((p) => p.id === open && p.enabled);
  const CurrentPage = WEB_PLUGINS.find((w) => w.id === current?.id)?.Page;
  if (current && CurrentPage) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
            <ArrowLeft /> {t("common.back")}
          </Button>
          <span className="font-medium">{pluginName(current)}</span>
        </div>
        <CurrentPage />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("plugins.intro")}</p>
      {error && <p className="text-destructive">{error}</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.map((p) => {
          const web = WEB_PLUGINS.find((w) => w.id === p.id);
          const Icon = web?.icon ?? Puzzle;
          const openable = p.enabled && !!web?.Page;
          return (
            <div key={p.id} className={cn("flex items-start gap-3 rounded-xl border p-4 transition-colors", openable && "hover:bg-accent/40")}>
              <button
                type="button"
                disabled={!openable}
                onClick={() => setOpen(p.id)}
                className="flex min-w-0 flex-1 items-start gap-3 text-left enabled:cursor-pointer"
              >
                <Icon className={cn("mt-0.5 size-5 shrink-0", p.enabled ? "text-primary" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-medium">
                    {pluginName(p)}
                    {openable && <ChevronRight className="size-4 text-muted-foreground" />}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{pluginDescription(p)}</span>
                </span>
              </button>
              <input
                type="checkbox"
                role="switch"
                aria-label={p.enabled ? t("plugins.disable") : t("plugins.enable")}
                title={p.enabled ? t("plugins.disable") : t("plugins.enable")}
                checked={p.enabled}
                onChange={() => void toggle(p)}
                className="relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/30 transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-background before:shadow before:transition-transform checked:bg-primary checked:before:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </div>
          );
        })}
        {list.length === 0 && !error && <p className="text-muted-foreground">{t("plugins.none")}</p>}
      </div>
    </div>
  );
}
