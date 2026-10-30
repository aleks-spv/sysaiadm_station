import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, type OpencodeOverlay, type OpencodePluginInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { useOverlay } from "./useOverlay";

function pluginLabel(p: OpencodePluginInfo): string {
  if (p.source.type === "package") return `${p.source.target}${p.source.version ? `@${p.source.version}` : ""}`;
  if (p.source.type === "local") return p.source.path;
  return p.id ?? p.source.type;
}

const entryName = (p: string | { package: string }) => (typeof p === "string" ? p : p.package);

export default function OpencodeConfigSection() {
  const { overlay, error, update } = useOverlay();
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<OpencodePluginInfo[]>([]);
  const [newPlugin, setNewPlugin] = useState("");

  const loadPlugins = () =>
    api
      .opencodePlugins()
      .then((r) => setPlugins(r.data))
      .catch(() => {});
  useEffect(() => {
    loadPlugins();
  }, []);

  useEffect(() => {
    if (overlay && !dirty) setText(JSON.stringify(overlay, null, 2));
  }, [overlay, dirty]);

  const save = async () => {
    let parsed: OpencodeOverlay;
    try {
      parsed = JSON.parse(text) as OpencodeOverlay;
    } catch (err) {
      return setMessage(t("opencode.notJson", { error: errorText(err) }));
    }
    try {
      await update(() => parsed);
      setDirty(false);
      setMessage(t("opencode.saved"));
      setTimeout(loadPlugins, 2000);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const addPlugin = async (e: FormEvent) => {
    e.preventDefault();
    const name = newPlugin.trim();
    if (!name) return;
    try {
      await update((o) => ({ ...o, plugins: [...(o.plugins ?? []).filter((p) => entryName(p) !== name), name] }));
      setNewPlugin("");
      setDirty(false);
      setTimeout(loadPlugins, 3000);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const removePlugin = (name: string) =>
    update((o) => ({ ...o, plugins: (o.plugins ?? []).filter((p) => entryName(p) !== name) }))
      .then(() => {
        setDirty(false);
        setTimeout(loadPlugins, 2000);
      })
      .catch((err: unknown) => setMessage(errorText(err)));

  const external = plugins.filter((p) => p.source.type !== "builtin");

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("opencode.intro")}</p>
        {error && <p className="text-destructive">{error}</p>}
        <textarea
          spellCheck={false}
          className={cn(fieldClass, "min-h-[28rem] font-mono text-xs leading-relaxed")}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => void save()} disabled={!dirty}>
            {t("common.save")}
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setDirty(false);
              setMessage(null);
            }}
          >
            {t("opencode.discard")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("opencode.ctrlSave")}</span>
          {message && <span className="ml-auto text-xs text-muted-foreground">{message}</span>}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">{t("opencode.plugins")}</h3>
        <p className="text-xs text-muted-foreground">{t("opencode.pluginsHint")}</p>
        <form onSubmit={addPlugin} className="flex gap-2">
          <Input placeholder="@scope/opencode-plugin" value={newPlugin} onChange={(e) => setNewPlugin(e.target.value)} />
          <Button type="submit" variant="outline" disabled={!newPlugin.trim()}>
            <Plus /> {t("common.add")}
          </Button>
        </form>
        <ul className="divide-y divide-border rounded-xl border">
          {(overlay?.plugins ?? []).map((p) => (
            <li key={entryName(p)} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{entryName(p)}</span>
              <Button variant="ghost" size="icon-sm" aria-label={t("common.remove")} onClick={() => void removePlugin(entryName(p))}>
                <Trash2 />
              </Button>
            </li>
          ))}
          {external.map((p, i) => (
            <li key={`live-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className={cn("size-2 rounded-full", p.state.status === "active" ? "bg-emerald-500" : "bg-destructive")} />
              <span className="min-w-0 flex-1 truncate font-mono">{pluginLabel(p)}</span>
              <span className="text-muted-foreground">{p.state.status === "active" ? t("opencode.running") : p.state.error}</span>
            </li>
          ))}
          {external.length === 0 && (overlay?.plugins ?? []).length === 0 && <li className="px-3 py-2 text-muted-foreground">{t("opencode.noExternal")}</li>}
        </ul>
        <p className="text-xs text-muted-foreground">{t("opencode.builtinCount", { count: plugins.length - external.length })}</p>
      </section>
    </div>
  );
}
