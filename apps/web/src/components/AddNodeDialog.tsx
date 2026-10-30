import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { InventoryNode, NodeKind, OsKind } from "@sysadm/shared";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorText, fieldClass } from "@/lib/utils";
import { t } from "@/i18n/app";

export const KIND_LABEL: Record<NodeKind, string> = {
  company: t("kind.company"),
  group: t("kind.group"),
  hypervisor: t("kind.hypervisor"),
  vm: t("kind.vm"),
};
// The OS picks the skills the agent gets; a hypervisor can be anything (Proxmox, Hyper-V, Xen, ESXi), so "other" is the default.
export const OS_LABEL: Record<OsKind, string> = { ubuntu: "Ubuntu", debian: "Debian", proxmox: "Proxmox VE", windows: "Windows", other: t("os.other") };
export const OSES = Object.keys(OS_LABEL) as OsKind[];

interface Props {
  // null: closed; { parent: null } adds a company at the root.
  target: { parent: InventoryNode | null; kind?: NodeKind } | null;
  onClose: () => void;
}

export default function AddNodeDialog({ target, onClose }: Props) {
  const navigate = useNavigate();
  const parent = target?.parent ?? null;
  const kinds: NodeKind[] = parent ? ["group", "hypervisor", "vm"] : ["company"];
  const [form, setForm] = useState({ kind: "company" as NodeKind, name: "", address: "", os: "ubuntu" as OsKind });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setForm({ kind: target.kind ?? (target.parent ? "vm" : "company"), name: "", address: "", os: target.kind === "hypervisor" ? "other" : "ubuntu" });
    setError(null);
  }, [target]);

  const host = form.kind === "vm" || form.kind === "hypervisor";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const node = await api.createNode({
        kind: form.kind,
        name: form.name.trim(),
        parentId: parent?.id ?? null,
        ...(host ? { address: form.address.trim() || null, os: form.os } : {}),
      });
      onClose();
      navigate(`/nodes/${node.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{parent ? t("add.titleIn", { name: parent.name }) : t("add.titleCompany")}</DialogTitle>
            <DialogDescription>
              {parent ? t("add.hintChild") : t("add.hintCompany")}
            </DialogDescription>
          </DialogHeader>
          {kinds.length > 1 && (
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setForm({ ...form, kind: k })}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${form.kind === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            {t("add.name")}
            <Input autoFocus required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          {host && (
            <div className="grid grid-cols-[1fr_8rem] gap-2">
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                {t("add.address")} {form.kind === "vm" && <span className="text-destructive">*</span>}
                <Input
                  required={form.kind === "vm"}
                  placeholder={t("add.addressPlaceholder")}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </label>
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                {t("add.os")}
                <select className={fieldClass} value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value as OsKind })}>
                  {OSES.map((o) => (
                    <option key={o} value={o}>
                      {OS_LABEL[o]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || !form.name.trim()}>{t("common.add")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
