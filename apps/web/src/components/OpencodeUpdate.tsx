import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { api, type OpencodeVersion } from "@/api";
import { Button } from "@/components/ui/button";
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

  if (done) {
    return (
      <div role="status" className="fixed right-4 bottom-4 z-50 rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg">
        {t("update.done", { version: done })}
      </div>
    );
  }
  if (!show || !info) return null;

  return (
    <div role="dialog" aria-label={t("update.available", { latest: info.latest ?? "" })} className="fixed right-4 bottom-4 z-50 w-80 rounded-xl border bg-popover p-4 text-sm shadow-lg">
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{missing ? t("update.missing") : t("update.available", { latest: info.latest ?? "" })}</p>
          <p className="text-muted-foreground">
            {missing ? t("update.missingHint", { latest: info.latest ?? "" }) : t("update.installed", { current: info.current ?? "" })}{" "}
            {!missing && (
              <a href={RELEASES} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                {t("update.notes")}
              </a>
            )}
          </p>
          {running > 0 && !busy && <p className="text-amber-500">{t("update.running", { count: running })}</p>}
          {error && <p className="text-destructive">{error}</p>}
        </div>
        {!missing && !busy && (
          <button type="button" onClick={later} aria-label={t("update.later")} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {busy ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("update.busy")}
          </span>
        ) : (
          <>
            {!missing && (
              <Button variant="ghost" size="sm" onClick={later}>
                {t("update.later")}
              </Button>
            )}
            <Button size="sm" onClick={() => void upgrade()}>
              {missing ? t("update.installFirst") : t("update.install")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
