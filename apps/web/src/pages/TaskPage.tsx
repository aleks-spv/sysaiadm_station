import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import type { Task } from "@sysadm/shared";
import { api, subscribeEvents, type PendingPermission } from "../api";
import PermissionPrompt from "../components/PermissionPrompt";

const STATUS_LABEL: Record<Task["status"], string> = {
  running: "выполняется",
  idle: "ожидает",
  waiting_permission: "ждёт подтверждения",
  stopped: "остановлена",
  error: "ошибка",
};

// The opencode message shape is read defensively: text parts are shown, anything else is skipped.
// Output is rendered as plain text, never as HTML.
function messageText(message: unknown): { role: string; text: string } {
  const m = message as { role?: unknown; parts?: unknown; content?: unknown };
  const role = typeof m.role === "string" ? m.role : "";
  const parts = Array.isArray(m.parts) ? m.parts : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  const text = parts
    .map((p) => {
      const part = p as { type?: unknown; text?: unknown };
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
  return { role, text };
}

export default function TaskPage() {
  const { id = "" } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<unknown[]>([]);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [steer, setSteer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .task(id)
      .then((r) => {
        setTask(r.task);
        setMessages(r.messages);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));
    api.pendingPermissions(id).then(setPending).catch(() => setPending([]));
  }, [id]);

  useEffect(() => {
    load();
    // Status changes for any task mean the chat may have new parts; refresh this one.
    return subscribeEvents((ev) => {
      if (ev.type === "task.status" && ev.taskId === id) load();
      if (ev.type === "resync") load();
    });
  }, [id, load]);

  const reply = async (requestID: string, decision: "once" | "always" | "reject") => {
    try {
      await api.replyPermission(id, requestID, decision);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  };

  const sendSteer = async (e: FormEvent) => {
    e.preventDefault();
    if (!steer.trim()) return;
    await api.promptTask(id, steer).catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));
    setSteer("");
    load();
  };

  const stop = () => api.stopTask(id).then(load).catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));

  if (!task) return <div className="p-4 text-sm">{error ?? "Загрузка…"}</div>;

  // Only the first pending request is shown: Enter/Esc act on it, so two prompts would conflict.
  const first = pending[0];

  return (
    <div className="flex h-full max-w-3xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <p className="text-xs text-neutral-500">
            {STATUS_LABEL[task.status]} · {new Date(task.createdAt).toLocaleString()}
          </p>
        </div>
        <button className="rounded border px-3 py-1 text-sm text-red-700" onClick={stop}>
          Стоп
        </button>
      </header>

      {first && <PermissionPrompt permission={first} onReply={(d) => reply(first.id, d)} />}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <ol className="flex-1 space-y-2 overflow-auto text-sm">
        {messages.map((m, i) => {
          const { role, text } = messageText(m);
          if (!text) return null;
          return (
            <li key={i} className={`whitespace-pre-wrap rounded p-2 ${role === "user" ? "bg-neutral-100" : "bg-white border"}`}>
              <span className="text-xs text-neutral-500">{role === "user" ? "вы" : "агент"}</span>
              <div>{text}</div>
            </li>
          );
        })}
      </ol>

      <form onSubmit={sendSteer} className="flex gap-2">
        <input
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="Уточнить у агента"
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
        />
        <button className="rounded bg-neutral-900 px-3 py-1 text-sm text-white">Отправить</button>
      </form>
    </div>
  );
}
