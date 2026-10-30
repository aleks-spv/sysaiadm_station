import { useEffect, useState } from "react";
import { api } from "@/api";
import { UpdateCard, UpdateDone } from "@/components/UpdateCard";
import { errorText } from "@/lib/utils";
import type { RtkVersion } from "./types";
import { t } from "./i18n";

const DISMISSED = "sysadm.rtkDismissed";
const CHECK_MS = 3600_000;
const RELEASES = "https://github.com/rtk-ai/rtk/releases";
// The rtk page fires this after a manual check, so a dismissed release shows again.
export const RTK_CHECKED = "sysadm:rtk-checked";

export default function RtkUpdate() {
  const [info, setInfo] = useState<RtkVersion | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.plugin<RtkVersion>("rtk", "GET", "/version").then(setInfo, () => {});
    const recheck = () => {
      localStorage.removeItem(DISMISSED);
      setDismissed(null);
      load();
    };
    load();
    const timer = setInterval(load, CHECK_MS);
    window.addEventListener(RTK_CHECKED, recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener(RTK_CHECKED, recheck);
    };
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 5000);
    return () => clearTimeout(timer);
  }, [done]);

  const upgrade = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.plugin<RtkVersion>("rtk", "POST", "/upgrade");
      setInfo(next);
      setDone(next.current);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const later = () => {
    if (!info?.latest) return;
    localStorage.setItem(DISMISSED, info.latest);
    setDismissed(info.latest);
  };

  if (done) return <UpdateDone text={t("update.done", { version: done })} />;
  if (!info || info.mode !== "managed" || !info.updateAvailable || dismissed === info.latest) return null;

  return (
    <UpdateCard
      title={t("update.available", { latest: info.latest ?? "" })}
      error={error}
      busy={busy}
      busyText={t("update.busy")}
      installText={info.current ? t("update.install") : t("update.installFirst")}
      onInstall={() => void upgrade()}
      onLater={later}
    >
      <p className="text-muted-foreground">
        {info.current ? t("update.installed", { current: info.current }) : t("update.missing")}{" "}
        <a href={RELEASES} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          {t("update.notes")}
        </a>
      </p>
    </UpdateCard>
  );
}
