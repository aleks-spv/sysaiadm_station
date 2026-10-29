import { useEffect } from "react";
import type { PendingPermission } from "../api";

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
      if (e.key === "Enter") onReply("once");
      if (e.key === "Escape") onReply("reject");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReply]);

  const via = permission.metadata?.via ?? [];
  const pattern = command.split(/\s+/)[0] ?? "";

  return (
    <div className={`space-y-2 rounded border-2 p-3 text-sm ${dangerous ? "border-red-600 bg-red-50" : "border-amber-400 bg-amber-50"}`}>
      <p className="font-medium">
        {dangerous ? "Опасная команда: нужно подтверждение, автопилот не действует" : "Команда ждёт подтверждения"}
      </p>
      <p className="text-xs text-neutral-600">
        узел: {permission.metadata?.node ?? "?"} · адрес: {permission.metadata?.address ?? "?"}
        {via.length > 0 && ` · через: ${via.join(" → ")}`}
      </p>
      <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-xs">{command}</pre>
      <div className="flex flex-wrap gap-2">
        <button className="rounded bg-neutral-900 px-3 py-1 text-white" onClick={() => onReply("once")}>
          Разрешить раз
        </button>
        {!dangerous && (
          <button className="rounded border px-3 py-1" onClick={() => onReply("always")}>
            Всегда для «{pattern} *»
          </button>
        )}
        <button className="rounded border px-3 py-1" onClick={() => onReply("reject")}>
          Отклонить
        </button>
      </div>
    </div>
  );
}
