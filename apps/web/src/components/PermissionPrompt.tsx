import { useEffect } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { PendingPermission } from "../api";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/app";

interface Props {
  permission: PendingPermission;
  onReply: (decision: "once" | "always" | "reject") => void;
}

// One pending approval. Enter allows once, Esc rejects. Dangerous commands never get "always".
// Note: the keyboard shortcuts act on every prompt on the page, so the page renders at most one at a time.
export default function PermissionPrompt({ permission, onReply }: Props) {
  const dangerous = permission.action === "remote_exec_dangerous";
  const command = permission.resources[0] ?? "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing in the composer must not approve a command.
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Enter") onReply("once");
      if (e.key === "Escape") onReply("reject");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReply]);

  const via = permission.metadata?.via ?? [];
  const pattern = command.split(/\s+/)[0] ?? "";
  const Icon = dangerous ? TriangleAlert : ShieldAlert;

  return (
    <div className={`space-y-3 rounded-xl border p-3 text-sm shadow-sm ${dangerous ? "border-destructive/50 bg-destructive/10" : "border-amber-500/40 bg-amber-500/10"}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 size-4 shrink-0 ${dangerous ? "text-destructive" : "text-amber-400"}`} />
        <div className="min-w-0">
          <p className="font-medium">{dangerous ? t("perm.dangerous") : t("perm.ask")}</p>
          <p className="text-xs text-muted-foreground">
            {permission.metadata?.node ?? "?"} · {permission.metadata?.address ?? "?"}
            {via.length > 0 && t("perm.via", { chain: via.join(" → ") })}
          </p>
        </div>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/70 p-2.5 font-mono text-xs">{command}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onReply("once")}>
          {t("perm.allow")} <kbd className="ml-1 rounded bg-primary-foreground/15 px-1 text-[10px]">Enter</kbd>
        </Button>
        {!dangerous && (
          <Button size="sm" variant="outline" onClick={() => onReply("always")}>
            {t("perm.always", { pattern })}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onReply("reject")}>
          {t("perm.deny")} <kbd className="ml-1 rounded bg-muted px-1 text-[10px]">Esc</kbd>
        </Button>
      </div>
    </div>
  );
}
