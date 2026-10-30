import { useEffect, useState } from "react";
import { api } from "@/api";
import { PLUGINS_CHANGED } from "@/components/settings/PluginsSection";
import { WEB_PLUGINS, type WebPlugin } from "@/plugins";

// Web halves of plugins that are enabled on the server; refreshes when Settings → Plugins toggles one.
export function useEnabledPlugins(): WebPlugin[] {
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = () =>
      api
        .plugins()
        .then((list) => setEnabled(new Set(list.filter((p) => p.enabled).map((p) => p.id))))
        .catch(() => setEnabled(new Set()));
    load();
    window.addEventListener(PLUGINS_CHANGED, load);
    return () => window.removeEventListener(PLUGINS_CHANGED, load);
  }, []);
  return WEB_PLUGINS.filter((p) => enabled.has(p.id));
}
