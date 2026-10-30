import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { Credential, InventoryNode, JumpMode, OsKind, ShellKind } from "@sysadm/shared";
import { api, CONFIG_CHANGED, type NodeDetail, type NodeFields, type Skill } from "@/api";
import { OS_LABEL, OSES } from "@/components/AddNodeDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { t } from "@/i18n/app";

const SHELLS: ShellKind[] = ["bash", "powershell"];

function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1 text-xs text-muted-foreground", className)}>
      {label}
      {children}
    </label>
  );
}

interface Props {
  detail: NodeDetail;
  nodes: InventoryNode[];
  onChanged: () => void;
}

export default function NodeSettings({ detail, nodes, onChanged }: Props) {
  const navigate = useNavigate();
  const { node, effective } = detail;
  const id = node.id;
  const [creds, setCreds] = useState<Credential[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState<NodeFields>({});
  const [skillIds, setSkillIds] = useState<string[]>(node.skills);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      Promise.all([api.credentials(), api.skills()])
        .then(([c, s]) => {
          setCreds(c);
          setSkills(s);
        })
        .catch((err: unknown) => setMessage(errorText(err)));
    void load();
    window.addEventListener(CONFIG_CHANGED, load);
    return () => window.removeEventListener(CONFIG_CHANGED, load);
  }, []);

  useEffect(() => {
    setDraft({});
    setSkillIds(node.skills);
    setMessage(null);
  }, [node]);

  // Local edits live in `draft`; the server value is shown until the user saves.
  const field = <K extends keyof NodeFields>(key: K, fallback: NodeFields[K]) => (key in draft ? draft[key] : fallback) as NodeFields[K];
  const set = <K extends keyof NodeFields>(key: K, value: NodeFields[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      setMessage(done);
      onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.updateNode(id, draft), t("node.saved"));
  };

  const removeNode = async () => {
    if (!window.confirm(t("node.confirmDelete", { name: node.name }))) return;
    try {
      await api.deleteNode(id);
      navigate("/");
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const host = node.kind === "vm" || node.kind === "hypervisor";
  const jumpMode = field("jumpMode", node.jumpMode) as JumpMode;
  const skillsChanged = skillIds.slice().sort().join() !== node.skills.slice().sort().join();

  return (
    <div className="space-y-5 text-sm">
      <form onSubmit={save} className="grid grid-cols-2 gap-3">
        <Field label={t("node.name")} className="col-span-2">
          <Input value={field("name", node.name) ?? ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={<>{t("node.address")} {node.kind === "vm" && <span className="text-destructive">*</span>}</>} className="col-span-2">
          <Input value={field("address", node.address) ?? ""} onChange={(e) => set("address", e.target.value || null)} />
        </Field>
        {host && (
          <Field label={t("node.os")}>
            <select className={fieldClass} value={field("os", node.os)} onChange={(e) => set("os", e.target.value as OsKind)}>
              {OSES.map((o) => (
                <option key={o} value={o}>
                  {OS_LABEL[o]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t("node.port")}>
          <Input
            type="number"
            placeholder={t("node.inheritedValue", { value: effective?.port ?? 22 })}
            value={field("port", node.port) ?? ""}
            onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)}
          />
        </Field>
        <Field label={t("node.user")}>
          <Input
            placeholder={effective?.user ? t("node.inheritedValue", { value: effective.user }) : t("node.inherits")}
            value={field("user", node.user) ?? ""}
            onChange={(e) => set("user", e.target.value || null)}
          />
        </Field>
        <Field label={t("node.shell")}>
          <select className={fieldClass} value={field("shell", node.shell) ?? ""} onChange={(e) => set("shell", (e.target.value || null) as ShellKind | null)}>
            <option value="">{`${t("common.inherited")} (${effective?.shell ?? "bash"})`}</option>
            {SHELLS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label={<>
              {t("node.credential")} {effective?.credentialFrom && !node.credentialId && <span>{t("node.credentialFrom", { from: effective.credentialFrom })}</span>}
            </>} className="col-span-2">
          <select className={fieldClass} value={field("credentialId", node.credentialId) ?? ""} onChange={(e) => set("credentialId", e.target.value || null)}>
            <option value="">{t("node.inherit")}</option>
            {creds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="col-span-2 grid gap-1.5 rounded-lg border p-2.5 text-xs">
          <legend className="px-1 text-muted-foreground">{t("node.connection")}</legend>
          {(["inherit", "direct", "via"] as JumpMode[]).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input type="radio" className="accent-primary" name="jump" checked={jumpMode === mode} onChange={() => set("jumpMode", mode)} />
              {mode === "inherit" &&
                `${t("node.jumpInherit")}${effective ? ` (${effective.jumpChain.length ? t("common.viaJump") : t("common.direct")}${effective.jumpFrom ? t("node.jumpFrom", { from: effective.jumpFrom }) : ""})` : ""}`}
              {mode === "direct" && t("node.jumpDirect")}
              {mode === "via" && t("node.jumpVia")}
            </label>
          ))}
          {jumpMode === "via" && (
            <select className={fieldClass} value={field("jumpNodeId", node.jumpNodeId) ?? ""} onChange={(e) => set("jumpNodeId", e.target.value || null)}>
              <option value="">{t("node.pickNode")}</option>
              {nodes
                .filter((n) => n.id !== id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
          )}
          {detail.routeError && <p className="text-destructive">{t("node.route", { error: detail.routeError })}</p>}
        </fieldset>

        {Object.keys(draft).length > 0 && (
          <div className="col-span-2 flex gap-2">
            <Button size="sm">{t("common.save")}</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDraft({})}>
              {t("node.revert")}
            </Button>
          </div>
        )}
      </form>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("node.skills")}</h3>
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s) => {
            const on = skillIds.includes(s.id);
            const from = effective?.skillSources[s.id];
            return (
              <button
                key={s.id}
                type="button"
                title={from ? t("node.skillFrom", { from }) : s.description}
                onClick={() => setSkillIds((ids) => (on ? ids.filter((x) => x !== s.id) : [...ids, s.id]))}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  on ? "border-primary/50 bg-primary/15 text-foreground" : from ? "border-dashed text-foreground/80" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.name}
              </button>
            );
          })}
        </div>
        {skillsChanged && (
          <Button size="sm" onClick={() => run(() => api.setNodeSkills(id, skillIds), t("node.skillsSaved"))}>
            {t("node.saveSkills")}
          </Button>
        )}
      </section>

      <section className="flex flex-wrap gap-2 border-t pt-4">
        {node.kind !== "vm" && (
          <Button size="sm" variant="outline" onClick={() => run(() => api.resetHostKey(id), t("node.hostKeyReset"))}>
            {t("node.resetHostKey")}
          </Button>
        )}
        <Button size="sm" variant="destructive" onClick={removeNode}>
          {t("node.delete")}
        </Button>
      </section>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
