import { useEffect, useState, type FormEvent } from "react";
import { Download, Upload } from "lucide-react";
import type { InventoryNode } from "@sysadm/shared";
import { api } from "@/api";
import ImportPanel from "@/components/ImportPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/settings";
import { errorText, fieldClass } from "@/lib/utils";

const MIN_PASSPHRASE = 12;

// Nodes indented by depth, for the "what to export" and "import under" selects.
function treeOptions(nodes: InventoryNode[]): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of nodes.filter((x) => x.parentId === parent)) {
      out.push({ id: n.id, label: `${"  ".repeat(depth)}${n.name}` });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ExportForm({ options, initialRoot }: { options: Array<{ id: string; label: string }>; initialRoot: string | null }) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [withSecrets, setWithSecrets] = useState(false);
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pass.length < MIN_PASSPHRASE) return setMessage(t("transfer.passShort", { min: MIN_PASSPHRASE }));
    if (pass !== repeat) return setMessage(t("transfer.passMismatch"));
    setBusy(true);
    try {
      const file = await api.exportInventory({ rootId: root || null, withSecrets, passphrase: pass });
      const label = options.find((o) => o.id === root)?.label.trim() ?? "inventory";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      a.download = `${label.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-${new Date().toISOString().slice(0, 10)}.sysaiadm`;
      a.click();
      URL.revokeObjectURL(a.href);
      setPass("");
      setRepeat("");
      setMessage(t("transfer.exported"));
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border p-4">
      <h3 className="font-medium">{t("transfer.exportTitle")}</h3>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t("transfer.what")}</span>
        <select className={fieldClass} value={root} onChange={(e) => setRoot(e.target.value)}>
          <option value="">{t("transfer.everything")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
        <span>
          {t("transfer.withSecrets")}
          <span className="block text-xs text-muted-foreground">{t("transfer.withSecretsHint")}</span>
        </span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input type="password" autoComplete="new-password" placeholder={t("transfer.pass")} value={pass} onChange={(e) => setPass(e.target.value)} />
        <Input type="password" autoComplete="new-password" placeholder={t("transfer.passRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">{t("transfer.passHint", { min: MIN_PASSPHRASE })}</p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          <Download /> {t("transfer.export")}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
    </form>
  );
}

function ImportForm({ options, onImported }: { options: Array<{ id: string; label: string }>; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parent, setParent] = useState("");
  const [pass, setPass] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setWarnings([]);
    try {
      const r = await api.importInventory(file, pass, parent || null);
      setMessage(t("transfer.imported", { nodes: r.nodes, credentials: r.credentials }));
      setWarnings(r.warnings);
      setPass("");
      onImported();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-xl border p-4">
      <h3 className="font-medium">{t("transfer.importTitle")}</h3>
      <input type="file" accept=".sysaiadm,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t("transfer.under")}</span>
        <select className={fieldClass} value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">{t("transfer.top")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <Input type="password" autoComplete="off" placeholder={t("transfer.pass")} value={pass} onChange={(e) => setPass(e.target.value)} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !file || !pass}>
          <Upload /> {t("transfer.import")}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
      {warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-500">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

// Import from other tools, and moving servers between SysAiAdm Station instances (passphrase-encrypted file).
export default function TransferSection({ parent }: { parent?: string | null }) {
  const [nodes, setNodes] = useState<InventoryNode[]>([]);
  const load = () => {
    api.tree().then(setNodes, () => {});
  };
  useEffect(load, []);
  const options = treeOptions(nodes);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("transfer.intro")}</p>
      <ExportForm key={parent ?? ""} options={options} initialRoot={parent ?? null} />
      <ImportForm options={options} onImported={load} />
      <div className="space-y-3 rounded-xl border p-4">
        <h3 className="font-medium">{t("transfer.otherTitle")}</h3>
        <ImportPanel parentId={parent ?? null} />
      </div>
    </div>
  );
}
