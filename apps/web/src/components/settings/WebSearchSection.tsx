import { useEffect, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { api, type IntegrationInfo, type WebSearchProvider, type WebSearchResult, type WebSearchSettings } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { errorText, fieldClass } from "@/lib/utils";

// Built into opencode; the key is stored as an opencode integration (same path as model provider keys).
const BUILTIN: Array<{ id: WebSearchProvider; name: string; keyOptional?: boolean }> = [
  { id: "exa", name: "Exa" },
  { id: "tavily", name: "Tavily" },
  { id: "firecrawl", name: "Firecrawl" },
  { id: "parallel", name: "Parallel" },
  { id: "tinyfish", name: "TinyFish", keyOptional: true },
];

export default function WebSearchSection() {
  const [settings, setSettings] = useState<WebSearchSettings | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [key, setKey] = useState("");
  const [query, setQuery] = useState("proxmox ve release notes");
  const [results, setResults] = useState<WebSearchResult[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadIntegrations = () => api.integrations().then((r) => setIntegrations(r.data), () => {});
  useEffect(() => {
    api.webSearch().then(setSettings, (err: unknown) => setMessage(errorText(err)));
    void loadIntegrations();
  }, []);

  if (!settings) return <p className="text-sm text-muted-foreground">{message ?? t("common.loading")}</p>;
  const builtin = BUILTIN.find((b) => b.id === settings.provider);
  const connected = builtin ? (integrations.find((i) => i.id === builtin.id)?.connections.length ?? 0) > 0 : false;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (builtin && key.trim()) {
        await api.setProviderKey(builtin.id, key.trim());
        setKey("");
        await loadIntegrations();
      }
      setSettings(await api.saveWebSearch(settings));
      setMessage(t("common.saved"));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const test = async () => {
    setBusy(true);
    setResults(null);
    try {
      setResults((await api.testWebSearch(query)).results);
      setMessage(null);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("websearch.intro")}</p>
      <form onSubmit={(e) => void save(e)} className="space-y-3 rounded-xl border p-4">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t("websearch.provider")}</span>
          <select className={fieldClass} value={settings.provider} onChange={(e) => setSettings({ ...settings, provider: e.target.value as WebSearchProvider })}>
            <option value="off">{t("websearch.off")}</option>
            <option value="searxng">{t("websearch.searxng")}</option>
            {BUILTIN.map((b) => (
              <option key={b.id} value={b.id}>
                {b.keyOptional ? `${b.name} ${t("websearch.noKey")}` : b.name}
              </option>
            ))}
          </select>
        </label>
        {settings.provider === "searxng" && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("websearch.searxngUrl")}</span>
            <Input placeholder="http://searxng:8080" value={settings.searxngUrl ?? ""} onChange={(e) => setSettings({ ...settings, searxngUrl: e.target.value })} />
            <span className="block text-xs text-muted-foreground">{t("websearch.searxngHint")}</span>
          </label>
        )}
        {builtin && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("websearch.key", { name: builtin.name })} · {connected ? t("websearch.connected") : builtin.keyOptional ? t("websearch.keyOptional") : t("websearch.notConnected")}
            </span>
            <Input type="password" autoComplete="off" placeholder={connected ? "••••••••" : ""} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t("websearch.maxResults")}</span>
          <Input type="number" min={1} max={20} className="w-28" value={settings.maxResults} onChange={(e) => setSettings({ ...settings, maxResults: Number(e.target.value) })} />
        </label>
        <Button type="submit">{t("common.save")}</Button>
      </form>

      <div className="space-y-3 rounded-xl border p-4">
        <h3 className="font-medium">{t("websearch.testTitle")}</h3>
        <div className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="button" variant="outline" disabled={busy || settings.provider === "off"} onClick={() => void test()}>
            <Search /> {t("websearch.test")}
          </Button>
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {results && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {results.map((r) => (
              <li key={r.url}>
                <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
                  {r.title || r.url}
                </a>
                <p className="line-clamp-2 text-xs text-muted-foreground">{r.content}</p>
              </li>
            ))}
            {results.length === 0 && <li className="list-none text-muted-foreground">{t("websearch.empty")}</li>}
          </ol>
        )}
      </div>
    </div>
  );
}
