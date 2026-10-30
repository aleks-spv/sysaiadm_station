import { useEffect, useState, type FormEvent } from "react";
import { DatabaseBackup, Download, Trash2 } from "lucide-react";
import { api, type BackupFile, type BackupSettings } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtNumber } from "@/i18n";
import { t } from "@/i18n/settings";
import { errorText } from "@/lib/utils";

const mb = (bytes: number) => fmtNumber(Math.round((bytes / 1024 / 1024) * 10) / 10);

// Scheduled SQLite snapshots kept by the server in <data>/backups.
export default function BackupsSection() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.backups().then(
      (r) => {
        setSettings(r.settings);
        setFiles(r.backups);
      },
      (err: unknown) => setMessage(errorText(err)),
    );
  useEffect(() => void load(), []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    try {
      setSettings(await api.saveBackupSettings(settings));
      setMessage(t("common.saved"));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const createNow = async () => {
    setBusy(true);
    try {
      await api.createBackup();
      await load();
      setMessage(t("backups.created"));
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(t("backups.confirmDelete", { name }))) return;
    try {
      await api.deleteBackup(name);
      await load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  if (!settings) return <p className="text-sm text-muted-foreground">{message ?? t("common.loading")}</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("backups.intro")}</p>
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
          {t("backups.enabled")}
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("backups.interval")}</span>
          <Input type="number" min={1} max={720} required className="w-28" value={settings.intervalHours}
            onChange={(e) => setSettings({ ...settings, intervalHours: Number(e.target.value) })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("backups.keep")}</span>
          <Input type="number" min={1} max={365} required className="w-28" value={settings.keep}
            onChange={(e) => setSettings({ ...settings, keep: Number(e.target.value) })} />
        </label>
        <Button type="submit" variant="outline">
          {t("common.save")}
        </Button>
        <Button type="button" onClick={() => void createNow()} disabled={busy}>
          <DatabaseBackup /> {t("backups.now")}
        </Button>
      </form>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      <ul className="divide-y divide-border rounded-xl border">
        {files.map((f) => (
          <li key={f.name} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">{f.name}</div>
              <div className="text-xs text-muted-foreground">
                {fmtDateTime(f.createdAt)} · {t("backups.size", { mb: mb(f.size) })}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" asChild aria-label={t("backups.download")}>
              <a href={`/api/backups/${encodeURIComponent(f.name)}`} download={f.name}>
                <Download />
              </a>
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void remove(f.name)} aria-label={t("backups.delete")}>
              <Trash2 />
            </Button>
          </li>
        ))}
        {files.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">{t("backups.empty")}</li>}
      </ul>
      <p className="text-xs text-muted-foreground">{t("backups.restore")}</p>
    </div>
  );
}
