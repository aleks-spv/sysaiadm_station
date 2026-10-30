import { useEffect, useState } from "react";
import { useOutletContext, useParams } from "react-router";
import { api } from "@/api";
import type { LayoutContext } from "@/App";
import { WEB_PLUGINS } from "@/plugins";
import { t } from "@/i18n/app";

export default function PluginPage() {
  const { id = "" } = useParams();
  const plugin = WEB_PLUGINS.find((p) => p.id === id);
  const { setSettings } = useOutletContext<LayoutContext>();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .plugins()
      .then((list) => setEnabled(list.find((p) => p.id === id)?.enabled ?? false))
      .catch(() => setEnabled(false));
  }, [id]);

  if (enabled === null) return null;
  if (!plugin?.Page || !enabled) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
        <p>
          {t("plugin.unavailable", { id, state: plugin ? t("plugin.disabled") : t("plugin.notFound") })}{" "}
          <button className="text-primary hover:underline" onClick={() => setSettings({ section: "plugins" })}>
            {t("plugin.settingsLink")}
          </button>
        </p>
      </div>
    );
  }
  const { Page } = plugin;
  return <Page />;
}
