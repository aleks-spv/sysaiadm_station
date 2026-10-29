import { useEffect, useState, type FormEvent } from "react";
import type { Credential } from "@sysadm/shared";
import { api, type ApiToken, type AuditRow, type Skill } from "../api";

type Tab = "credentials" | "skills" | "providers" | "tokens" | "audit";
const TABS: Array<[Tab, string]> = [
  ["credentials", "Креды"],
  ["skills", "Скилы"],
  ["providers", "Провайдеры"],
  ["tokens", "API-токены"],
  ["audit", "Аудит"],
];
const SCOPES: Array<[string, string]> = [
  ["read", "чтение"],
  ["tasks", "задачи"],
  ["approve", "ответы на запросы"],
  ["logs", "логи"],
  ["admin", "управление"],
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

// The raw token is shown once, from component memory only: it is never stored or logged.
function TokensTab() {
  const [list, setList] = useState<ApiToken[]>([]);
  const [form, setForm] = useState({ name: "", scopes: ["read"], ttlDays: "90" });
  const [created, setCreated] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.tokens().then(setList).catch((err: unknown) => setMessage(errorText(err)));
  useEffect(() => {
    load();
  }, []);

  const toggle = (scope: string) =>
    setForm((f) => ({ ...f, scopes: f.scopes.includes(scope) ? f.scopes.filter((s) => s !== scope) : [...f.scopes, scope] }));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.createToken({ name: form.name, scopes: form.scopes, ttlDays: Number(form.ttlDays) });
      setCreated(res.token);
      setForm({ name: "", scopes: ["read"], ttlDays: "90" });
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const revoke = (t: ApiToken) => {
    if (!window.confirm(`Отозвать токен «${t.name}»?`)) return;
    api.revokeToken(t.id).then(load).catch((err: unknown) => setMessage(errorText(err)));
  };

  const date = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());

  return (
    <div className="space-y-4">
      {created && (
        <div className="space-y-2 rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p>Токен показан один раз. Сохраните его сейчас: повторно он не отображается.</p>
          <code className="block break-all">{created}</code>
          <div className="flex gap-3">
            <button className={buttonClass} onClick={() => void navigator.clipboard.writeText(created)}>
              Скопировать
            </button>
            <button className="text-sm underline" onClick={() => setCreated(null)}>
              Готово
            </button>
          </div>
        </div>
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1">Имя</th>
            <th>Scope'ы</th>
            <th>Создан</th>
            <th>Истекает</th>
            <th>Последнее использование</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className="border-t">
              <td className="py-1">{t.name}</td>
              <td>{t.scopes.join(", ")}</td>
              <td>{date(t.createdAt)}</td>
              <td>{date(t.expiresAt)}</td>
              <td>{date(t.lastUsedAt)}</td>
              <td>
                {t.revokedAt === null ? (
                  <button className="text-red-700 underline" onClick={() => revoke(t)}>
                    Отозвать
                  </button>
                ) : (
                  <span className="text-neutral-500">отозван</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} className="space-y-2 text-sm">
        <input className={inputClass} placeholder="Имя токена" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <div className="flex flex-wrap gap-3">
          {SCOPES.map(([id, label]) => (
            <label key={id} className="flex items-center gap-1">
              <input type="checkbox" checked={form.scopes.includes(id)} onChange={() => toggle(id)} />
              {id} <span className="text-neutral-500">({label})</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          Срок, дней
          <input
            className="w-24 rounded border border-neutral-300 px-2 py-1"
            type="number"
            min={1}
            max={365}
            value={form.ttlDays}
            onChange={(e) => setForm({ ...form, ttlDays: e.target.value })}
          />
        </label>
        <button className={buttonClass} disabled={!form.name || form.scopes.length === 0}>
          Создать токен
        </button>
      </form>
      {message && <p className="text-sm text-neutral-600">{message}</p>}
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
      {tab === "tokens" && <TokensTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
