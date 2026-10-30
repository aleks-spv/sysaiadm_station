import type { Database } from "bun:sqlite";
import type { ChatCommand } from "@sysadm/shared";
import { Hono } from "hono";
import { audit } from "../guard";
import { getSetting, setSetting } from "../settings";

const KEY = "chat_commands";
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const AGENT = /^[\w.-]{1,64}$/;
const MAX_COMMANDS = 100;
// Built into the chat, not templates: /init collects the server card.
export const RESERVED = ["init"];

export const DEFAULT_COMMANDS: ChatCommand[] = [
  {
    name: "health",
    description: "Быстрая проверка здоровья сервера",
    agent: null,
    template:
      "Быстро проверь здоровье сервера: аптайм и нагрузку, память и swap, место и иноды на дисках, упавшие юниты systemd, ошибки журнала за последний час, давно не обновлявшиеся пакеты. Ничего не меняй. Ответ — короткая таблица «что / норма или проблема / цифра», ниже только проблемы с предложением, что делать.\n\n$ARGUMENTS",
  },
  {
    name: "disk",
    description: "Что занимает место; аргумент — путь",
    agent: null,
    template:
      "Найди, что занимает место на диске. Путь: $ARGUMENTS (если пусто — начни с корня и самых заполненных разделов). Покажи топ каталогов и крупных файлов, старые логи, кеши пакетов, docker-образы и тома, если есть. Ничего не удаляй, предложи безопасную очистку с оценкой, сколько освободится.",
  },
  {
    name: "logs",
    description: "Ошибки в журналах; аргумент — сервис или период",
    agent: "debugger",
    template:
      "Разбери ошибки в журналах. Фильтр: $ARGUMENTS (сервис или период; если пусто — все сервисы за последние 6 часов). Сгруппируй повторяющиеся ошибки, для каждой группы — сколько раз, когда впервые и последний раз, вероятная причина. Ничего не меняй.",
  },
  {
    name: "updates",
    description: "Доступные обновления, без установки",
    agent: null,
    template:
      "Проверь доступные обновления пакетов, отдельно обновления безопасности, и нужна ли перезагрузка (ядро, libc). Ничего не устанавливай. Ответ: сколько всего, список обновлений безопасности, что потребует рестарта сервисов или перезагрузки.\n\n$ARGUMENTS",
  },
  {
    name: "security",
    description: "Быстрый аудит безопасности",
    agent: "debugger",
    template:
      "Сделай быстрый аудит безопасности без изменений: слушающие порты и кто их держит, настройки sshd (вход root, пароли), неудачные входы за сутки, пользователи с оболочкой и sudo, файрвол, fail2ban, просроченные сертификаты. Ответ — список находок по важности с конкретной командой исправления.\n\n$ARGUMENTS",
  },
  {
    name: "net",
    description: "Сеть: интерфейсы, маршруты, DNS, порты",
    agent: null,
    template:
      "Опиши сеть сервера: интерфейсы и адреса (без docker/veth), маршруты, DNS, слушающие порты, установленные соединения по сервисам. Если указана цель — проверь до неё связность (ping, порт, traceroute): $ARGUMENTS",
  },
  {
    name: "service",
    description: "Состояние сервиса; аргумент — имя",
    agent: "debugger",
    template:
      "Разбери сервис $ARGUMENTS: статус юнита, когда и сколько раз перезапускался, последние 100 строк его журнала, конфиг и его проверка (nginx -t и т.п.), порты, потребление памяти и CPU. Если сервис падает — найди причину. Ничего не перезапускай без вопроса.",
  },
];

export function validateCommands(input: unknown): ChatCommand[] | string {
  if (!Array.isArray(input)) return "commands должен быть списком";
  if (input.length > MAX_COMMANDS) return `не больше ${MAX_COMMANDS} команд`;
  const seen = new Set<string>();
  const out: ChatCommand[] = [];
  for (const raw of input) {
    const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim().replace(/^\//, "") : "";
    if (!NAME.test(name)) return `имя «${name}»: латиница в нижнем регистре, цифры, - и _, до 32 символов`;
    if (RESERVED.includes(name)) return `/${name} — встроенная команда`;
    if (seen.has(name)) return `команда /${name} повторяется`;
    seen.add(name);
    const description = typeof c.description === "string" ? c.description.trim() : "";
    if (description.length > 200) return `/${name}: описание длиннее 200 символов`;
    const template = typeof c.template === "string" ? c.template : "";
    if (!template.trim() || template.length > 8000) return `/${name}: текст команды пустой или длиннее 8000 символов`;
    const agent = typeof c.agent === "string" && c.agent ? c.agent : null;
    if (agent !== null && !AGENT.test(agent)) return `/${name}: неверное имя агента`;
    out.push({ name, description, template, agent });
  }
  return out;
}

export function getCommands(db: Database): ChatCommand[] {
  return getSetting<ChatCommand[]>(db, KEY) ?? DEFAULT_COMMANDS;
}

export function commandsRoutes(db: Database): Hono {
  const app = new Hono();
  app.get("/api/commands", (c) => c.json({ commands: getCommands(db), defaults: DEFAULT_COMMANDS, reserved: RESERVED }));
  app.put("/api/commands", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { commands?: unknown } | null;
    const commands = validateCommands(body?.commands);
    if (typeof commands === "string") return c.json({ error: commands }, 400);
    setSetting(db, KEY, commands);
    audit(db, { actor: c.get("actor"), action: "commands_update", detail: { names: commands.map((x) => x.name) } });
    return c.json({ commands });
  });
  return app;
}
