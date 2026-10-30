import { useEffect, useState, type FormEvent } from "react";
import type { Credential } from "@sysadm/shared";
import { api, type ApiToken, type AuditRow } from "@/api";
import { fmtDateTime } from "@/i18n";
import { t } from "@/i18n/settings";
import { errorText, fieldClass } from "@/lib/utils";

const SCOPES: Array<[string, string]> = [
  ["read", t("tokens.scopeRead")],
  ["tasks", t("tokens.scopeTasks")],
  ["approve", t("tokens.scopeApprove")],
  ["logs", t("tokens.scopeLogs")],
  ["admin", t("tokens.scopeAdmin")],
];
const inputClass = fieldClass;
export const buttonClass = "h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50";

export function CredentialsTab() {
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
      setMessage(t("common.saved"));
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
              {c.name} <span className="text-muted-foreground">({c.type})</span>
            </span>
            <button className="text-destructive underline" onClick={() => remove(c.id)}>
              {t("common.delete")}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        <input className={inputClass} placeholder={t("common.displayName")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "key" | "password" })}>
          <option value="key">{t("credentials.typeKey")}</option>
          <option value="password">{t("credentials.password")}</option>
        </select>
        <textarea
          className={`${inputClass} col-span-2 font-mono`}
          rows={form.type === "key" ? 4 : 1}
          placeholder={form.type === "key" ? t("credentials.privateKey") : t("credentials.password")}
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
        />
        {form.type === "key" && (
          <input className={inputClass} type="password" placeholder={t("credentials.passphrase")} value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} />
        )}
        <button className={buttonClass} disabled={!form.name || !form.secret}>
          {t("common.save")}
        </button>
      </form>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}

export function AuditTab() {
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
      <input className={inputClass} placeholder={t("audit.nodeIdPlaceholder")} value={nodeId} onChange={(e) => setNodeId(e.target.value.trim())} />
      {error && <p className="text-destructive">{error}</p>}
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="pr-2">{t("audit.time")}</th>
            <th className="pr-2">{t("audit.who")}</th>
            <th className="pr-2">{t("common.action")}</th>
            <th>{t("audit.details")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="pr-2">{fmtDateTime(r.ts)}</td>
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
export function TokensTab() {
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

  const revoke = (tok: ApiToken) => {
    if (!window.confirm(t("tokens.confirmRevoke", { name: tok.name }))) return;
    api.revokeToken(tok.id).then(load).catch((err: unknown) => setMessage(errorText(err)));
  };

  const date = (ms: number | null) => (ms === null ? "—" : fmtDateTime(ms));

  return (
    <div className="space-y-4">
      {created && (
        <div className="space-y-2 rounded border border-amber-500 bg-amber-500/10 p-3 text-sm">
          <p>{t("tokens.shownOnce")}</p>
          <code className="block break-all">{created}</code>
          <div className="flex gap-3">
            <button className={buttonClass} onClick={() => void navigator.clipboard.writeText(created)}>
              {t("common.copy")}
            </button>
            <button className="text-sm underline" onClick={() => setCreated(null)}>
              {t("common.done")}
            </button>
          </div>
        </div>
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1">{t("common.name")}</th>
            <th>{t("tokens.scopes")}</th>
            <th>{t("tokens.created")}</th>
            <th>{t("tokens.expires")}</th>
            <th>{t("tokens.lastUsed")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((tok) => (
            <tr key={tok.id} className="border-t">
              <td className="py-1">{tok.name}</td>
              <td>{tok.scopes.join(", ")}</td>
              <td>{date(tok.createdAt)}</td>
              <td>{date(tok.expiresAt)}</td>
              <td>{date(tok.lastUsedAt)}</td>
              <td>
                {tok.revokedAt === null ? (
                  <button className="text-destructive underline" onClick={() => revoke(tok)}>
                    {t("tokens.revoke")}
                  </button>
                ) : (
                  <span className="text-muted-foreground">{t("tokens.revoked")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} className="space-y-2 text-sm">
        <input className={inputClass} placeholder={t("tokens.namePlaceholder")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <div className="flex flex-wrap gap-3">
          {SCOPES.map(([id, label]) => (
            <label key={id} className="flex items-center gap-1">
              <input type="checkbox" checked={form.scopes.includes(id)} onChange={() => toggle(id)} />
              {id} <span className="text-muted-foreground">({label})</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          {t("tokens.ttl")}
          <input
            className="w-24 rounded border border-input px-2 py-1"
            type="number"
            min={1}
            max={365}
            value={form.ttlDays}
            onChange={(e) => setForm({ ...form, ttlDays: e.target.value })}
          />
        </label>
        <button className={buttonClass} disabled={!form.name || form.scopes.length === 0}>
          {t("tokens.create")}
        </button>
      </form>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
