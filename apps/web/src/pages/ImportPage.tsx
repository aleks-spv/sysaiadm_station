import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ImportPreview, ImportSource } from "@sysadm/shared";
import { api, type ApplyResult } from "../api";

const SOURCES: Array<{ id: ImportSource; label: string; hint: string }> = [
  { id: "rustconn", label: "RustConn", hint: "rustconn-cli export -f native -o x.rcn" },
  { id: "rdm", label: "Remote Desktop Manager (JSON)", hint: "RDM: File → Export → Export All (.json)" },
  { id: "mremoteng", label: "mRemoteNG", hint: "confCons.xml без шифрования (Full file encryption выключено)" },
  { id: "ansible", label: "Ansible inventory", hint: "inventory.ini или inventory.yml" },
];

export default function ImportPage() {
  const [params] = useSearchParams();
  const parentId = params.get("parent");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [source, setSource] = useState<ImportSource>("rustconn");
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setError(err instanceof Error ? err.message : "Ошибка");
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
      setError(err instanceof Error ? err.message : "Ошибка");
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
    <div className="max-w-3xl space-y-4 p-4 text-sm">
      <h1 className="text-lg font-semibold">Импорт</h1>
      <p className="text-xs text-neutral-500">Пароли из файла не переносятся: кред назначается на узел после импорта.</p>

      {error && <p className="text-red-600">{error}</p>}

      {step === 1 && (
        <section className="space-y-3">
          <div className="space-y-2">
            {SOURCES.map((s) => (
              <label key={s.id} className="flex items-start gap-2">
                <input type="radio" name="source" checked={source === s.id} onChange={() => setSource(s.id)} />
                <span>
                  {s.label}
                  <span className="block text-xs text-neutral-500">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <input type="file" accept=".rcn,.json,.xml,.ini,.yml,.yaml,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div>
            <button className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50" disabled={!file || busy} onClick={upload}>
              Предпросмотр
            </button>
          </div>
        </section>
      )}

      {step === 2 && preview && (
        <section className="space-y-3">
          <p>Снимите галочку, чтобы пропустить запись (вместе с вложенными).</p>
          {preview.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-700">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <table className="w-full text-left">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="w-8" />
                <th>Имя</th>
                <th>Тип</th>
                <th>Адрес</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.key} className="border-t">
                  <td>
                    <input type="checkbox" checked={!skipped.has(item.key)} onChange={() => toggle(item.key)} />
                  </td>
                  <td>{item.name}</td>
                  <td>{item.kind === "group" ? "группа" : "ВМ"}</td>
                  <td className="font-mono text-xs">{item.address ?? ""}</td>
                  <td>{item.action === "skip" ? <span className="rounded bg-neutral-200 px-1 text-xs">exists</span> : "создать"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <button className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50" disabled={busy} onClick={apply}>
              Применить
            </button>
            <button className="rounded border px-3 py-1.5" onClick={() => setStep(1)}>
              Назад
            </button>
          </div>
        </section>
      )}

      {step === 3 && result && (
        <section className="space-y-2">
          <p>
            Создано: {result.created}, пропущено: {result.skipped}
          </p>
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-700">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <Link className="underline" to="/">
            Открыть дерево
          </Link>
        </section>
      )}
    </div>
  );
}
