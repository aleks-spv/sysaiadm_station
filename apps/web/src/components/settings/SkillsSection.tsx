import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { api, type Skill, type SkillScan } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/settings";
import { cn, errorText } from "@/lib/utils";

interface ParsedSource {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

// github:owner/repo@ref:path
const SOURCE_RE = /^github:([^@]+)@([^:]+):(.+)$/;

function parseSource(source: string | null | undefined): ParsedSource | null {
  if (!source) return null;
  const m = SOURCE_RE.exec(source);
  if (!m) return null;
  const [, ownerRepo, ref, path] = m;
  const slash = ownerRepo.indexOf("/");
  if (slash === -1) return null;
  return {
    owner: ownerRepo.slice(0, slash),
    repo: ownerRepo.slice(slash + 1),
    ref,
    path,
  };
}

function getBadge(s: Skill) {
  if (s.builtin) return { label: t("skills.badgeBuiltin"), cls: "bg-slate-500/15 text-slate-400" };
  if (s.shipped) return { label: t("skills.badgeEdited"), cls: "bg-amber-500/15 text-amber-500" };
  if (s.source?.startsWith("github:")) {
    const p = parseSource(s.source);
    return { label: `GitHub (${p ? `${p.owner}/${p.repo}` : s.source})`, cls: "bg-blue-500/15 text-blue-400" };
  }
  return { label: t("skills.badgeCustom"), cls: "bg-muted text-muted-foreground" };
}

function InstallResult({ result }: { result: { installed: string[]; updated: string[]; skipped: Array<{ id: string; reason: string }> } }) {
  return (
    <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
      <p>{t("skills.installed", { count: result.installed.length, list: result.installed.join(", ") || "—" })}</p>
      {result.updated.length > 0 && <p>{t("skills.updated", { count: result.updated.length, list: result.updated.join(", ") })}</p>}
      {result.skipped.length > 0 && (
        <p className="text-destructive">{t("skills.skipped", { list: result.skipped.map((s) => `${s.id} — ${s.reason}`).join("; ") })}</p>
      )}
    </div>
  );
}

export default function SkillsSection() {
  const [list, setList] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", description: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The right pane shows the GitHub installer instead of the editor.
  const [githubOpen, setGithubOpen] = useState(false);

  // GitHub install state
  const [githubInput, setGithubInput] = useState("");
  const [githubRef, setGithubRef] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<SkillScan | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ installed: string[]; updated: string[]; skipped: Array<{ id: string; reason: string }> } | null>(null);

  const existsMap = useMemo(() => {
    const map = new Map<string, Skill>();
    for (const s of list) map.set(s.id, s);
    return map;
  }, [list]);

  const load = () => {
    setLoading(true);
    api.skills()
      .then(setList)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [list, search]);

  const selected = selectedId ? list.find((s) => s.id === selectedId) ?? null : null;

  const resetForm = () => {
    setForm({ id: "", name: "", description: "", content: "" });
    setSelectedId(null);
    setCreating(false);
    setGithubOpen(false);
    setMessage(null);
  };

  const startNew = () => {
    resetForm();
    setCreating(true);
  };

  const selectSkill = (s: Skill) => {
    setSelectedId(s.id);
    setCreating(false);
    setGithubOpen(false);
    setMessage(null);
    setForm({ id: s.id, name: s.name, description: s.description, content: s.content });
  };

  const resetToOriginal = async (id: string) => {
    if (!window.confirm(t("skills.confirmReset", { id }))) return;
    try {
      await api.resetSkill(id);
      resetForm();
      setMessage(t("skills.restored"));
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const saveSkill = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (selectedId) await api.updateSkill(selectedId, { name: form.name, description: form.description, content: form.content });
      else await api.createSkill(form);
      // Stay on the saved skill, so the admin sees the result instead of an empty panel.
      setCreating(false);
      setSelectedId(selectedId ?? form.id);
      setMessage(selectedId ? t("skills.saved") : t("skills.added"));
      load();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteSkill = async (id: string) => {
    if (!window.confirm(t("skills.confirmDelete", { id }))) return;
    try {
      await api.deleteSkill(id);
      if (selectedId === id) resetForm();
      load();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const refreshGithubSkill = async () => {
    if (!selected) return;
    const parsed = parseSource(selected.source);
    if (!parsed) return;
    try {
      setInstalling(true);
      // Pulls the latest of the repo's default branch, not the pinned ref.
      const repo = `${parsed.owner}/${parsed.repo}`;
      const scan = await api.scanSkills(repo);
      await api.installSkills(repo, scan.ref, [parsed.path]);
      setMessage(t("skills.updatedFromGithub"));
      load();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setInstalling(false);
    }
  };

  // GitHub install flow
  const scanGithub = async (e: FormEvent) => {
    e.preventDefault();
    // The server parses owner/repo and github.com links, including /tree/<ref>/<dir>.
    const repo = githubInput.trim();
    if (!repo) return;
    setScanning(true);
    setScanResult(null);
    setSelectedPaths(new Set());
    setInstallResult(null);
    try {
      const scan = await api.scanSkills(repo, githubRef.trim() || undefined);
      setScanResult(scan);
      setSelectedPaths(new Set(scan.skills.filter((s) => !s.exists).map((s) => s.path)));
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setScanning(false);
    }
  };

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const installSelected = async () => {
    if (!scanResult || selectedPaths.size === 0) return;
    setInstalling(true);
    setInstallResult(null);
    try {
      const res = await api.installSkills(githubInput.trim(), scanResult.ref, [...selectedPaths]);
      setInstallResult(res);
      load();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setInstalling(false);
    }
  };

  const hintCls = "text-xs text-muted-foreground";

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant={githubOpen ? "secondary" : "outline"}
          onClick={() => {
            resetForm();
            setGithubOpen(true);
          }}
        >
          <GitBranch className="size-4" /> {t("skills.installFromGithub")}
        </Button>
        <Button size="sm" onClick={startNew}>
          <Plus className="size-4" /> {t("skills.new")}
        </Button>
      </div>

      {/* Two-column: list + editor */}
      {/* Fills the rest of the settings window; the list and the editor scroll inside. */}
      <div className="grid min-h-96 flex-1 grid-cols-[1fr_1.5fr] grid-rows-[minmax(0,1fr)] gap-4">
        {/* Left: list */}
        <div className="flex min-h-0 flex-col gap-2">
          <Input
            placeholder={t("skills.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
            {loading && list.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <p className="p-3 text-destructive">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="p-3 text-muted-foreground">{t("skills.none")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((s) => (
                  <li
                    key={s.id}
                    className={cn(
                      "cursor-pointer border-b last:border-b-0 px-3 py-2 transition-colors hover:bg-accent/50",
                      selectedId === s.id && "bg-accent",
                    )}
                    onClick={() => selectSkill(s)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" title={s.id}>{s.name || s.id}</span>
                      <span className={cn("ml-auto max-w-[45%] shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px]", getBadge(s).cls)}>
                        {getBadge(s).label}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{s.description || "—"}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex flex-col overflow-y-auto rounded-lg border p-4">
          {githubOpen ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" />
                <h3 className="font-medium">{t("skills.installFromGithub")}</h3>
              </div>
              <form onSubmit={scanGithub} className="space-y-2">
                <Input
                  placeholder={t("skills.repoPlaceholder")}
                  value={githubInput}
                  onChange={(e) => setGithubInput(e.target.value)}
                />
                <Input
                  placeholder={t("skills.refPlaceholder")}
                  value={githubRef}
                  onChange={(e) => setGithubRef(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button type="submit" disabled={scanning || !githubInput.trim()}>
                    {scanning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                    {t("skills.scan")}
                  </Button>
                </div>
              </form>
              <p className={hintCls}>{t("skills.githubHint")}</p>
              {scanResult && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("skills.found", { count: scanResult.skills.length, owner: scanResult.owner, repo: scanResult.repo, ref: scanResult.ref })}
                  </p>
                  <ul className="space-y-1">
                    {scanResult.skills.map((s) => {
                      const existing = existsMap.get(s.id);
                      const source = existing?.source;
                      const isGithub = source?.startsWith("github:");
                      let label: string;
                      if (s.exists) label = isGithub ? t("skills.statusUpdate") : t("skills.statusExists");
                      else label = t("skills.statusInstall");
                      return (
                        <li key={s.path} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedPaths.has(s.path)}
                            onChange={() => togglePath(s.path)}
                            disabled={s.exists && !isGithub}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.path}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{s.name || s.id}</span>
                          {s.exists && (
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
                                label === t("skills.statusUpdate") ? "bg-amber-500/15 text-amber-400" : "bg-muted text-muted-foreground",
                              )}
                            >
                              {label}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex items-center gap-2">
                    <Button onClick={installSelected} disabled={installing || selectedPaths.size === 0}>
                      {installing ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                      {t("skills.installSelected", { count: selectedPaths.size })}
                    </Button>
                  </div>
                  {installResult && <InstallResult result={installResult} />}
                </div>
              )}
              {message && <p className="text-sm text-destructive">{message}</p>}
            </section>
          ) : !selected && !creating ? (
            <div className="space-y-2 py-12 text-center">
              <p className="text-muted-foreground">{t("skills.pickHint")}</p>
              {message && <p className="text-sm">{message}</p>}
            </div>
          ) : (
            <form onSubmit={saveSkill} className="flex flex-1 flex-col gap-3">
              {selected?.shipped && (
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  {selected.builtin ? t("skills.builtinHint") : t("skills.editedHint")}
                </p>
              )}
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">id</span>
                <Input
                  value={form.id}
                  disabled={!!selectedId}
                  required
                  pattern="[a-z0-9][a-z0-9\-]{0,63}"
                  onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">{t("common.displayName")}</span>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">{t("common.description")}</span>
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("skills.content")}</span>
                <Textarea
                  className="min-h-60 flex-1 resize-none font-mono text-sm field-sizing-fixed"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving || !form.name.trim()}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("common.save")}
                </Button>
                {selected && (
                  <>
                    {selected.source?.startsWith("github:") && (
                      <Button type="button" variant="outline" onClick={refreshGithubSkill} disabled={installing}>
                        <RefreshCw className={cn("size-4", installing && "animate-spin")} />
                        {t("skills.refreshGithub")}
                      </Button>
                    )}
                    {selected.shipped && !selected.builtin && (
                      <Button type="button" variant="outline" onClick={() => resetToOriginal(selected.id)}>
                        <RotateCcw className="size-4" />
                        {t("skills.restore")}
                      </Button>
                    )}
                    {!selected.shipped && (
                      <Button type="button" variant="destructive" className="ml-auto" onClick={() => deleteSkill(selected.id)}>
                        <Trash2 className="size-4" />
                        {t("common.delete")}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {message && <p className="text-sm text-muted-foreground">{message}</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
