import { useEffect, useState, type FormEvent } from "react";
import type { Credential } from "@sysadm/shared";
import { api, type AuditRow, type Skill } from "../api";

type Tab = "credentials" | "skills" | "providers" | "audit";
const TABS: Array<[Tab, string]> = [
  ["credentials", "Креды"],
  ["skills", "Скилы"],
  ["providers", "Провайдеры"],
  ["audit", "Аудит"],
];
const inputClass = "w-full rounded border border-neutral-300 px-2 py-1 text-sm";
const buttonClass = "rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Ошибка";
}

function CredentialsTab() {
  const [list, setList] = useState<Credential[]>([]);
  const [form, setForm] = useState({ name: "", type: "key" as "key" | "password", secret: "", passphrase: "" });
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.credentials().then(setList).catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
  }, []);

  // The secret never comes back from the server, and the field is cleared right after saving.
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body =
        form.type === "key"
          ? { name: form.name, type: "key" as const, privateKey: form.secret, passphrase: form.passphrase || undefined }
          : { name: form.name, type: "password" as const, password: form.secret };
      await api.createCredential(body);
      setForm({ name: "", type: form.type, secret: "", passphrase: "" });
      setMessage("Сохранено");
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const remove = (id: string) =>
    api.deleteCredential(id).then(load).catch((err: unknown) => setMessage(errorText(err)));

  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        {list.map((c) => (
          <li key={c.id} className="flex justify-between">
            <span>
              {c.name} <span className="text-neutral-500">({c.type})</span>
            </span>
            <button className="text-red-700 underline" onClick={() => remove(c.id)}>
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        <input className={inputClass} placeholder="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "key" | "password" })}>
          <option value="key">SSH-ключ</option>
          <option value="password">Пароль</option>
        </select>
        <textarea
          className={`${inputClass} col-span-2 font-mono`}
          rows={form.type === "key" ? 4 : 1}
          placeholder={form.type === "key" ? "Приватный ключ (PEM)" : "Пароль"}
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
        />
        {form.type === "key" && (
          <input className={inputClass} type="password" placeholder="Passphrase (если есть)" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} />
        )}
        <button className={buttonClass} disabled={!form.name || !form.secret}>
          Сохранить
        </button>
      </form>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}

function SkillsTab() {
  const [list, setList] = useState<Skill[]>([]);
  const [form, setForm] = useState({ id: "", name: "", description: "", content: "" });
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.skills().then(setList).catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createSkill(form);
      setForm({ id: "", name: "", description: "", content: "" });
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        {list.map((s) => (
          <li key={s.id} className="flex justify-between">
            <span>
              {s.name} <span className="text-neutral-500">{s.builtin ? "(встроенный)" : `(${s.id})`}</span>
            </span>
            {!s.builtin && (
              <button className="text-red-700 underline" onClick={() => api.deleteSkill(s.id).then(load).catch((err: unknown) => setMessage(errorText(err)))}>
                Удалить
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="space-y-2">
        <input className={inputClass} placeholder="id (a-z, 0-9, -)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <input className={inputClass} placeholder="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={inputClass} placeholder="Описание" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <textarea className={`${inputClass} font-mono`} rows={6} placeholder="Markdown-инструкция для агента" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        <button className={buttonClass} disabled={!form.id || !form.name}>
          Добавить скил
        </button>
      </form>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}

function ProvidersTab() {
  const [providers, setProviders] = useState<unknown>(null);
  const [providerId, setProviderId] = useState("");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.providers().then(setProviders).catch((err: unknown) => setMessage(errorText(err)));
  }, []);

  // The key is sent once and cleared; it is never stored in the browser.
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setProviderKey(providerId, key);
      setKey("");
      setMessage("Ключ сохранён");
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <pre className="max-h-48 overflow-auto rounded bg-neutral-100 p-2 text-xs">{JSON.stringify(providers, null, 2)}</pre>
      <form onSubmit={save} className="grid grid-cols-2 gap-2">
        <input className={inputClass} placeholder="id провайдера" value={providerId} onChange={(e) => setProviderId(e.target.value)} />
        <input className={inputClass} type="password" placeholder="API-ключ" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className={buttonClass} disabled={!providerId || !key}>
          Сохранить ключ
        </button>
      </form>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .audit({ nodeId: nodeId || undefined, limit: 500 })
      .then(setRows)
      .catch((err: unknown) => setError(errorText(err)));
  }, [nodeId]);

  return (
    <div className="space-y-3">
      <input className={inputClass} placeholder="id узла (пусто — все)" value={nodeId} onChange={(e) => setNodeId(e.target.value.trim())} />
      {error && <p className="text-red-600">{error}</p>}
      <table className="w-full text-left text-xs">
        <thead className="text-neutral-500">
          <tr>
            <th className="pr-2">Время</th>
            <th className="pr-2">Кто</th>
            <th className="pr-2">Действие</th>
            <th>Детали</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="pr-2">{new Date(r.ts).toLocaleString()}</td>
              <td className="pr-2">{r.actor}</td>
              <td className="pr-2">{r.action}</td>
              <td className="break-all font-mono">{r.detail ? JSON.stringify(r.detail) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("credentials");
  return (
    <div className="max-w-3xl space-y-4 p-4">
      <h1 className="text-lg font-semibold">Настройки</h1>
      <nav className="flex gap-2 border-b text-sm">
        {TABS.map(([id, label]) => (
          <button key={id} className={`px-3 py-1 ${tab === id ? "border-b-2 border-neutral-900 font-medium" : "text-neutral-500"}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "credentials" && <CredentialsTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
