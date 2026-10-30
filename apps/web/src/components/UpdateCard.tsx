import type { ReactNode } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/app";

// Corner card for "a new release is out" (opencode, plugins' binaries); the Layout stacks them bottom-right.
export function UpdateCard(props: {
  title: string;
  children?: ReactNode;
  error?: string | null;
  busy: boolean;
  busyText: string;
  installText: string;
  onInstall: () => void;
  onLater?: () => void;
}) {
  const { title, children, error, busy, busyText, installText, onInstall, onLater } = props;
  return (
    <div role="dialog" aria-label={title} className="w-80 rounded-xl border bg-popover p-4 text-sm shadow-lg">
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{title}</p>
          {children}
          {error && <p className="text-destructive">{error}</p>}
        </div>
        {onLater && !busy && (
          <button type="button" onClick={onLater} aria-label={t("update.later")} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {busy ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {busyText}
          </span>
        ) : (
          <>
            {onLater && (
              <Button variant="ghost" size="sm" onClick={onLater}>
                {t("update.later")}
              </Button>
            )}
            <Button size="sm" onClick={onInstall}>
              {installText}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function UpdateDone({ text }: { text: string }) {
  return (
    <div role="status" className="rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg">
      {text}
    </div>
  );
}
