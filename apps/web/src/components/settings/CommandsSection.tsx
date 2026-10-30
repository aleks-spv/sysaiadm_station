import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { ChatCommand } from "@sysadm/shared";
import { api, type AgentInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/settings";
import { cn, errorText, fieldClass } from "@/lib/utils";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface Form {
  name: string;
  description: string;
  agent: string;
  template: string;
}

const emptyForm: Form = { name: "", description: "", agent: "", template: "" };

export default function CommandsSection() {
  const [list, setList] = useState<ChatCommand[]>([]);
  const [defaults, setDefaults] = useState<ChatCommand[]>([]);
  const [reserved, setReserved] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "new" while creating, list index while editing, null when the editor is closed.
  const [editIndex, setEditIndex] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.commands(), api.agents()])
      .then(([cmds, ags]) => {
        setList(cmds.commands);
        setDefaults(cmds.defaults);
        setReserved(cmds.reserved);
        setAgents(ags.data.filter((a) => !a.hidden && a.mode !== "subagent"));
      })
      .catch((err: unknown) => setLoadError(errorText(err)))
      .finally(() => setLoading(false));
  }, []);

  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? id : null);

  const openNew = () => {
    setEditIndex("new");
    setForm(emptyForm);
    setError(null);
  };

  const openEdit = (i: number) => {
    const c = list[i];
    setEditIndex(i);
    setForm({ name: c.name, description: c.description, agent: c.agent ?? "", template: c.template });
    setError(null);
  };

  const closeEditor = () => {
    setEditIndex(null);
    setError(null);
  };

  // The whole list is saved on every change; the server's copy becomes the state.
  const persist = async (next: ChatCommand[]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveCommands(next);
      setList(res.commands);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const others = list.filter((_, i) => i !== editIndex);
    let problem: string | null = null;
    if (!NAME_RE.test(name)) problem = t("commands.nameRule");
    else if (reserved.includes(name)) problem = t("commands.reserved", { name });
    else if (others.some((c) => c.name === name)) problem = t("commands.exists", { name });
    else if (!form.template.trim()) problem = t("commands.emptyText");
    if (problem) {
      setError(problem);
      return;
    }
    const entry: ChatCommand = {
      name,
      description: form.description.trim(),
      template: form.template,
      agent: form.agent || null,
    };
    const next = editIndex === "new" ? [...list, entry] : list.map((c, i) => (i === editIndex ? entry : c));
    if (await persist(next)) closeEditor();
  };

  const remove = async (i: number) => {
    const c = list[i];
    if (!window.confirm(t("commands.confirmDelete", { name: c.name }))) return;
    if (!(await persist(list.filter((_, j) => j !== i)))) return;
    if (editIndex === i) closeEditor();
    else if (typeof editIndex === "number" && editIndex > i) setEditIndex(editIndex - 1);
  };

  const restoreDefaults = async () => {
    if (!window.confirm(t("commands.confirmRestore"))) return;
    if (await persist(defaults)) closeEditor();
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t("commands.intro")}</p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={restoreDefaults} disabled={saving}>
            <RotateCcw className="size-4" /> {t("commands.restoreDefaults")}
          </Button>
          <Button size="sm" onClick={openNew} disabled={saving}>
            <Plus className="size-4" /> {t("commands.new")}
          </Button>
        </div>
      </div>

      {/* Fills the settings window; the list scrolls inside, the text area takes the rest of the height. */}
      <div className="grid min-h-96 flex-1 grid-cols-[1fr_1.5fr] grid-rows-[minmax(0,1fr)] gap-4">
        {/* Left: list */}
        <div className="overflow-y-auto rounded-lg border">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : loadError ? (
            <p className="p-3 text-destructive">{loadError}</p>
          ) : list.length === 0 ? (
            <p className="p-3 text-muted-foreground">{t("commands.none")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((c, i) => (
                <li
                  key={c.name}
                  className={cn("cursor-pointer space-y-1 px-3 py-2 transition-colors hover:bg-accent/50", editIndex === i && "bg-accent")}
                  onClick={() => openEdit(i)}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">/{c.name}</span>
                    {c.agent && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {agentName(c.agent)}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{c.description || "—"}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right: editor */}
        <div className="flex flex-col overflow-y-auto rounded-lg border p-4">
          {editIndex === null ? (
            <p className="py-12 text-center text-muted-foreground">{t("commands.pickHint")}</p>
          ) : (
            <form onSubmit={save} className="flex flex-1 flex-col gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("common.name")}</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-sm text-muted-foreground">/</span>
                  <input
                    className={cn(fieldClass, "font-mono")}
                    value={form.name}
                    maxLength={32}
                    onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
                  />
                </div>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("common.description")}</span>
                <input
                  className={fieldClass}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("commands.agent")}</span>
                <select
                  className={fieldClass}
                  value={form.agent}
                  onChange={(e) => setForm({ ...form, agent: e.target.value })}
                >
                  <option value="">{t("commands.agentAsChat")}</option>
                  {form.agent && !agents.some((a) => a.id === form.agent) && (
                    <option value={form.agent}>{form.agent}</option>
                  )}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("commands.text")}</span>
                <textarea
                  className={cn(fieldClass, "min-h-40 flex-1 resize-none font-mono text-xs")}
                  value={form.template}
                  onChange={(e) => setForm({ ...form, template: e.target.value })}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {t("common.save")}
                </Button>
                {typeof editIndex === "number" && (
                  <Button type="button" variant="destructive" className="ml-auto" onClick={() => remove(editIndex)} disabled={saving}>
                    <Trash2 className="size-4" /> {t("common.delete")}
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
