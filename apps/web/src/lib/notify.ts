import { useEffect } from "react";
import { useNavigate } from "react-router";
import { api, subscribeEvents } from "@/api";
import { getPrefs } from "@/lib/prefs";
import { t } from "@/i18n/app";

const TEXT: Record<string, string> = {
  idle: t("notify.idle"),
  error: t("notify.error"),
  waiting_permission: t("notify.waiting_permission"),
};

// Browser notification when a task needs the admin while the tab is in the background (Settings → General).
export function useTaskNotifications(): void {
  const navigate = useNavigate();
  useEffect(
    () =>
      subscribeEvents((ev) => {
        const text = ev.status && TEXT[ev.status];
        if (ev.type !== "task.status" || !ev.taskId || !text || !document.hidden) return;
        if (!getPrefs().notify || !("Notification" in window) || Notification.permission !== "granted") return;
        api
          .task(ev.taskId)
          .then(({ task }) => {
            const n = new Notification(text, { body: task.title, tag: task.id });
            n.onclick = () => {
              window.focus();
              navigate(`/nodes/${task.nodeId}/tasks/${task.id}`);
              n.close();
            };
          })
          .catch(() => {});
      }),
    [navigate],
  );
}
