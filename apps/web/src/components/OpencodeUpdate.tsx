import { useEffect, useState } from "react";
import { api, type OpencodeVersion } from "@/api";
import { UpdateCard, UpdateDone } from "@/components/UpdateCard";
import { errorText } from "@/lib/utils";
import { t } from "@/i18n/app";

const DISMISSED = "sysadm.opencodeDismissed";
const CHECK_MS = 3600_000;
const POLL_MS = 2000;
const RELEASES = "https://github.com/anomalyco/opencode/releases";
// Settings → System fires this after a manual check, so a dismissed release shows again.
export const OPENCODE_CHECKED = "sysadm:opencode-checked";

// Small corner card like OpenChamber's: a new opencode release (or a missing binary) with a one-click update.
export default function OpencodeUpdate() {
  const [info, setInfo] = useState<OpencodeVersion | null>(null);
  const [running, setRunning] = useState(0);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.opencodeVersion().then(setInfo, () => {});
    const recheck = () => {
      localStorage.removeItem(DISMISSED);
      setDismissed(null);
      load();
    };
    load();
    const timer = setInterval(load, CHECK_MS);
    window.addEventListener(OPENCODE_CHECKED, recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener(OPENCODE_CHECKED, recheck);
    };
  }, []);

  const missing = info?.mode === "managed" && info.current === null && info.latest !== null;
  const show = info?.mode === "managed" && (missing || (info.updateAvailable && dismissed !== info.latest));

  useEffect(() => {
    if (show) api.systemHealth().then((h) => setRunning(h.tasks.running), () => {});
  }, [show]);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 5000);
    return () => clearTimeout(timer);
  }, [done]);

  const upgrade = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.upgradeOpencode();
      // The server upgrades in the background; poll until it settles.
      let next = await api.opencodeVersion();
      while (next.busy) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        next = await api.opencodeVersion();
      }
      setInfo(next);
      if (next.error) setError(next.error);
      else setDone(next.current);
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
  if (!show || !info) return null;

  return (
    <UpdateCard
      title={missing ? t("update.missing") : t("update.available", { latest: info.latest ?? "" })}
      error={error}
      busy={busy}
      busyText={t("update.busy")}
      installText={missing ? t("update.installFirst") : t("update.install")}
      onInstall={() => void upgrade()}
      onLater={missing ? undefined : later}
    >
      <p className="text-muted-foreground">
        {missing ? t("update.missingHint", { latest: info.latest ?? "" }) : t("update.installed", { current: info.current ?? "" })}{" "}
        {!missing && (
          <a href={RELEASES} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
            {t("update.notes")}
          </a>
        )}
      </p>
      {running > 0 && !busy && <p className="text-amber-500">{t("update.running", { count: running })}</p>}
    </UpdateCard>
  );
}
