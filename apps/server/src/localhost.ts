import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { audit } from "./guard";
import { createNode, getNode, LOCALHOST_NODE } from "./inventory";
import { getSetting, setSetting } from "./settings";
import { seal } from "./vault";

// The image runs sshd on 127.0.0.1:22 for an unprivileged user (docker/entrypoint.sh), so the station can manage itself.
export const LOCAL_SSH_USER = "localadm";
// Its AGENTS.md gets SYSADM_OC_RULES (materialize.ts), whatever the admin writes in the notes.
export { LOCALHOST_NODE };

export const SYSADM_OC_RULES = `## Управление opencode этой станции
Этот сервер — контейнер самой SysAiAdm Station, а её opencode — тот, в котором работаешь ты. Меняй его только командой \`sysadm-oc\` через \`remote_exec\`; /data и /infra тебе недоступны. Админ команд не помнит: его просьбы («какие модели есть», «поставь плагин», «обнови opencode») переводи в них сам.
- \`sysadm-oc models\` — доступные модели (provider/model)
- \`sysadm-oc providers\` — провайдеры и подключён ли ключ
- \`sysadm-oc plugins\` — плагины opencode и их состояние
- \`sysadm-oc config\` — оверлей opencode.json, секреты скрыты как "<redacted>"
- \`sysadm-oc version\` — установленная и последняя версия opencode
- \`sysadm-oc set-config '<json>'\` — заменить оверлей целиком: возьми \`sysadm-oc config\`, поправь копию, "<redacted>" оставь как есть; permissions и policies менять нельзя
- \`sysadm-oc plugin-add <пакет>\` — добавить плагин из npm (имя, можно с @версией)
- \`sysadm-oc restart\` — перезапустить opencode
- \`sysadm-oc upgrade\` — обновить opencode до последней 2.x и перезапустить

Изменяющие команды (set-config, plugin-add, restart, upgrade) всегда ждут подтверждения админа. restart и upgrade обрывают эту задачу: сначала подведи итог и предупреди, потом запускай. Ключи провайдеров ты не видишь и не вводишь: попроси админа подключить их в Настройки → Провайдеры.`;

// Built in: organization "SysAiAdm" with host localhost and its key, created on start when missing.
// inventory.ts refuses to delete or move them.
export function seedLocalhost(db: Database, masterKey: Buffer, keyFile: string | undefined, now: () => number = Date.now): boolean {
  const known = getSetting<string>(db, LOCALHOST_NODE);
  if (known && getNode(db, known)) return false;
  // Builds before the protection did not remember the id: adopt their node if it is still there.
  const old = db.query<{ id: string }, [string]>("SELECT id FROM nodes WHERE kind = 'vm' AND address = '127.0.0.1' AND user = ? LIMIT 1").get(LOCAL_SSH_USER);
  if (old) {
    setSetting(db, LOCALHOST_NODE, old.id);
    return false;
  }
  if (!keyFile || !existsSync(keyFile)) return false;
  const privateKey = readFileSync(keyFile, "utf8");
  db.transaction(() => {
    const credentialId = crypto.randomUUID();
    const sealed = seal(masterKey, JSON.stringify({ privateKey }), credentialId);
    db.run(
      "INSERT INTO credentials (id, name, type, user, ciphertext, iv, tag, created_at) VALUES (?, ?, 'key', ?, ?, ?, ?, ?)",
      [credentialId, "localhost", LOCAL_SSH_USER, sealed.ciphertext, sealed.iv, sealed.tag, now()],
    );
    const orgId =
      db.query<{ id: string }, []>("SELECT id FROM nodes WHERE kind = 'company' AND parent_id IS NULL AND name = 'SysAiAdm' LIMIT 1").get()?.id ??
      createNode(db, { parentId: null, kind: "company", name: "SysAiAdm" }).id;
    const host = createNode(db, {
      parentId: orgId,
      kind: "vm",
      name: "localhost",
      os: "debian",
      address: "127.0.0.1",
      port: 22,
      user: LOCAL_SSH_USER,
      shell: "bash",
      credentialId,
      jumpMode: "direct",
      notes: "Контейнер самой SysAiAdm Station: непривилегированный пользователь, без sudo и без доступа к /data и /infra.",
    });
    setSetting(db, LOCALHOST_NODE, host.id);
    audit(db, { actor: "system", action: "localhost_seed", nodeId: host.id });
  })();
  return true;
}
