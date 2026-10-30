import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { ImportPreview, ImportSource } from "@sysadm/shared";
import { api, type ApplyResult } from "../api";
import { t } from "@/i18n/settings";

const SOURCES: Array<{ id: ImportSource; label: string; hint: string }> = [
  { id: "rustconn", label: "RustConn", hint: "rustconn-cli export -f native -o x.rcn" },
  { id: "rdm", label: "Remote Desktop Manager (JSON)", hint: "RDM: File → Export → Export All (.json)" },
  { id: "mremoteng", label: "mRemoteNG", hint: t("import.mremotengHint") },
  { id: "ansible", label: "Ansible inventory", hint: t("import.ansibleHint") },
];

// parentId: the node new entries go under; null puts them at the root.
export default function ImportPanel({ parentId }: { parentId: string | null }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [source, setSource] = useState<ImportSource>("rustconn");
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importPreview(file, source, parentId);
      setToken(res.token);
      setPreview(res.preview);
      setSkipped(new Set());
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  // The server applies the token once; a second click after success is refused with 409.
  const apply = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importApply(token, [...skipped]));
      setToken(null);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">{t("import.passwordsNote")}</p>

      {error && <p className="text-destructive">{error}</p>}

      {step === 1 && (
        <section className="space-y-3">
          <div className="space-y-2">
            {SOURCES.map((s) => (
              <label key={s.id} className="flex items-start gap-2">
                <input type="radio" name="source" checked={source === s.id} onChange={() => setSource(s.id)} />
                <span>
                  {s.label}
                  <span className="block text-xs text-muted-foreground">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <input
            ref={picker}
            type="file"
            hidden
            accept=".rcn,.json,.xml,.ini,.yml,.yaml,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50" disabled={busy} onClick={() => picker.current?.click()}>
              <Upload className="size-3.5" />
              {t("import.pickFile")}
            </button>
            <button className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50" disabled={!file || busy} onClick={upload}>
              {t("import.preview")}
            </button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{file ? file.name : t("import.noFile")}</span>
          </div>
        </section>
      )}

      {step === 2 && preview && (
        <section className="space-y-3">
          <p>{t("import.uncheckHint")}</p>
          {preview.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-400">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <table className="w-full text-left">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="w-8" />
                <th>{t("common.name")}</th>
                <th>{t("import.type")}</th>
                <th>{t("import.address")}</th>
                <th>{t("common.action")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.key} className="border-t">
                  <td>
                    <input type="checkbox" checked={!skipped.has(item.key)} onChange={() => toggle(item.key)} />
                  </td>
                  <td>{item.name}</td>
                  <td>{item.kind === "vm" ? t("import.kindVm") : item.kind === "company" ? t("import.kindCompany") : t("import.kindGroup")}</td>
                  <td className="font-mono text-xs">{item.address ?? ""}</td>
                  <td>{item.action === "skip" ? <span className="rounded bg-accent px-1 text-xs">exists</span> : t("import.create")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50" disabled={busy} onClick={apply}>
              {t("import.apply")}
            </button>
            <button className="h-8 rounded-lg border px-3 hover:bg-muted" onClick={() => setStep(1)}>
              {t("common.back")}
            </button>
          </div>
        </section>
      )}

      {step === 3 && result && (
        <section className="space-y-2">
          <p>{t("import.result", { created: result.created, skipped: result.skipped })}</p>
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-400">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">{t("import.treeHint")}</p>
        </section>
      )}
    </div>
  );
}
