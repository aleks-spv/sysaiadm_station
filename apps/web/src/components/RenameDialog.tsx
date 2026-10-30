import { useState } from "react";
import type { InventoryNode } from "@sysadm/shared";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/utils";
import { t } from "@/i18n/app";

// Opened from the tree's context menu. The name is only a label: ids, paths and history stay the same.
export default function RenameDialog({ node, onClose, onDone }: { node: InventoryNode; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === node.name) return onClose();
    setBusy(true);
    try {
      await api.updateNode(node.id, { name: trimmed });
      onDone();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("rename.title", { name: node.name })}</DialogTitle>
          </DialogHeader>
          <Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} aria-label={t("rename.label")} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !trimmed}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
