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
  },
});
