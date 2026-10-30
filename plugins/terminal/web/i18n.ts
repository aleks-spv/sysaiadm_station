import { defineMessages } from "@/i18n";

export const t = defineMessages({
  ru: {
    "status.idle": "не подключено",
    "status.connecting": "подключение…",
    "status.connected": "подключено: {node}",
    "status.via": "(через {via})",
    "status.exited": "сессия завершена (код {code})",
    "status.closed": "соединение закрыто",
    "status.disconnected": "отключено",
    reconnect: "Переподключить",
    disconnect: "Отключить",
    connect: "Подключиться",
    copy: "Копировать выделенное (Ctrl+C при выделении, Ctrl+Shift+C)",
    paste: "Вставить (Ctrl+V, Ctrl+Shift+V)",
    clipboardDenied: "Браузер не дал доступ к буферу обмена: нужен HTTPS или разрешение. Ctrl+V работает и без него.",
  },
  en: {
    "status.idle": "not connected",
    "status.connecting": "connecting…",
    "status.connected": "connected: {node}",
    "status.via": "(via {via})",
    "status.exited": "session ended (code {code})",
    "status.closed": "connection closed",
    "status.disconnected": "disconnected",
    reconnect: "Reconnect",
    disconnect: "Disconnect",
    connect: "Connect",
    copy: "Copy selection (Ctrl+C with a selection, Ctrl+Shift+C)",
    paste: "Paste (Ctrl+V, Ctrl+Shift+V)",
    clipboardDenied: "The browser denied clipboard access: HTTPS or a permission is required. Ctrl+V works without it.",
  },
});
