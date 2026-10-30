import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting, setSetting } from "./settings";

// The admin edits an overlay; sysadm owns the security keys and its own plugin entry in the written opencode.json.
export type Overlay = Record<string, unknown>;

const OVERLAY_KEY = "opencode_overlay";
const MAX_OVERLAY_BYTES = 256 * 1024;
export const LOCKED_KEYS = ["permissions", "policies"] as const;

const SYSADMIN_PROMPT = `Ты Sysadmin: опытный системный администратор Linux, Windows Server и гипервизоров (Proxmox VE, Hyper-V, Xen, VMware ESXi). Ты выполняешь работы на сервере этой сессии: настройка, обновления, установка, правка конфигов, перезапуск служб.

Правила:
- Команды выполняй только инструментом remote_exec. Другой машины у тебя нет.
- Сначала разведка: ОС, версия, что запущено, свободное место. Не угадывай, проверяй.
- Перед изменением файла сделай копию рядом (file.bak-YYYYMMDD-HHMM) и покажи diff после правки.
- Проверяй конфиг до перезапуска (nginx -t, sshd -t, apachectl configtest, systemd-analyze verify).
- Опасные шаги (перезагрузка, удаление данных, сеть, файрвол, SSH) объясняй заранее одной строкой: что сделаешь и как откатить.
- Не трогай то, о чём не просили. Не ставь лишние пакеты.
- После работы проверь результат и кратко отчитайся: что сделано, чем проверено, что осталось.
Отвечай на языке пользователя, коротко.`;

const DEBUGGER_PROMPT = `Ты Debugger: инженер по диагностике. Твоя задача — найти причину проблемы на сервере этой сессии, а не чинить вслепую.

Порядок работы:
1. Уточни симптом: что сломалось, когда, что менялось.
2. Собери факты только чтением: uptime, нагрузка, df -h, free -m, dmesg -T | tail, journalctl -p err -b, systemctl --failed, статус и логи нужной службы, сеть (ss -tulpn, ip a, ip r), для гипервизора — его инструменты (Proxmox: pvesh, qm/pct status, zpool status; Hyper-V: Get-VM; Xen: xl list; ESXi: esxcli, vim-cmd); для Windows — Get-EventLog, Get-Service.
3. Выдвини гипотезы и проверь каждую командой. Пиши, что подтверждено, а что нет.
4. Итог: причина, доказательства (вывод команд), предлагаемое исправление и риск.

Ничего не меняй на сервере без явного разрешения пользователя: только чтение и диагностика. Если для проверки нужен изменяющий шаг, спроси.
Отвечай на языке пользователя, коротко и по делу.`;

// Seeded once; after that the stored overlay is the admin's and is never rewritten by sysadm.
export const DEFAULT_OVERLAY: Overlay = {
  default_agent: "sysadmin",
  agents: {
    build: { disabled: true },
    plan: { disabled: true },
    sysadmin: { mode: "primary", description: "Выполняет работы на сервере", system: SYSADMIN_PROMPT, color: "#4f9d69" },
    debugger: { mode: "primary", description: "Диагностика: находит причину проблемы, ничего не меняет", system: DEBUGGER_PROMPT, color: "#d08a3a" },
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Returns Russian error messages; empty when the overlay is acceptable.
export function validateOverlay(value: unknown): string[] {
  if (!isObject(value)) return ["Конфиг должен быть JSON-объектом"];
  const errors: string[] = [];
  if (JSON.stringify(value).length > MAX_OVERLAY_BYTES) errors.push("Конфиг больше 256 КБ");
  for (const key of LOCKED_KEYS) {
    if (key in value) errors.push(`Ключ "${key}" управляется SysAiAdm Station (подтверждения и запреты агента), его нельзя менять`);
  }
  if ("agents" in value) {
    if (!isObject(value.agents)) errors.push(`"agents" должен быть объектом`);
    else {
      for (const [id, agent] of Object.entries(value.agents)) {
        if (!/^[\w.\/-]{1,64}$/.test(id)) errors.push(`Недопустимое имя агента "${id}"`);
        if (!isObject(agent)) errors.push(`Агент "${id}" должен быть объектом`);
        else if ("permissions" in agent) errors.push(`Агент "${id}": permissions управляются SysAiAdm Station`);
      }
    }
  }
  if ("providers" in value && !isObject(value.providers)) errors.push(`"providers" должен быть объектом`);
  if ("plugins" in value) {
    const ok =
      Array.isArray(value.plugins) &&
      value.plugins.every((p) => (typeof p === "string" && p.length > 0) || (isObject(p) && typeof p.package === "string"));
    if (!ok) errors.push(`"plugins" должен быть списком строк или объектов {"package": "..."}`);
  }
  return errors;
}

export function getOverlay(db: Database): Overlay {
  const stored = getSetting<Overlay>(db, OVERLAY_KEY);
  if (stored) return stored;
  setSetting(db, OVERLAY_KEY, DEFAULT_OVERLAY);
  return DEFAULT_OVERLAY;
}

export function saveOverlay(db: Database, overlay: Overlay): void {
  setSetting(db, OVERLAY_KEY, overlay);
}

export function buildOpencodeConfig(base: Record<string, unknown>, pluginPath: string, overlay: Overlay): Record<string, unknown> {
  const extra = Array.isArray(overlay.plugins) ? overlay.plugins : [];
  const locked = Object.fromEntries(LOCKED_KEYS.filter((k) => k in base).map((k) => [k, base[k]]));
  return { ...base, ...overlay, plugins: [{ package: pluginPath }, ...extra], ...locked };
}

// opencode watches this file and reloads agents, providers and plugins without a restart.
export function writeOpencodeConfig(infraDir: string, config: Record<string, unknown>): void {
  mkdirSync(infraDir, { recursive: true });
  const target = join(infraDir, "opencode.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, target);
}
