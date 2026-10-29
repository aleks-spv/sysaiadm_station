import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import type { Credential, InventoryNode, JumpMode, NodeKind, OsKind, ShellKind, Task } from "@sysadm/shared";
import { api, type NodeDetail, type NodeFields, type Skill } from "../api";

const inputClass = "w-full rounded border border-neutral-300 px-2 py-1 text-sm";
const buttonClass = "rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50";
const OSES: OsKind[] = ["ubuntu", "debian", "proxmox", "windows", "other"];
const SHELLS: ShellKind[] = ["bash", "powershell"];
const KINDS: NodeKind[] = ["company", "group", "hypervisor", "vm"];
const KIND_LABEL: Record<NodeKind, string> = { company: "Компания", group: "Группа", hypervisor: "Гипервизор", vm: "ВМ" };

// Turns the ancestor chain into the route shown to the user: sysadm → bastion → node.
function routeLine(detail: NodeDetail, nodes: InventoryNode[]): string {
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  const chain = detail.effective?.jumpChain.map((id) => names.get(id) ?? id) ?? [];
  return ["sysadm", ...chain, detail.node.name].join(" → ");
}

export default function NodePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [all, setAll] = useState<InventoryNode[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState<NodeFields>({});
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [child, setChild] = useState({ kind: "vm" as NodeKind, name: "" });
  const [task, setTask] = useState({ title: "", prompt: "" });
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    Promise.all([api.node(id), api.tree(), api.credentials(), api.skills(), api.tasks()])
      .then(([d, tree, c, s, t]) => {
        setDetail(d);
        setAll(tree);
        setCreds(c);
        setSkills(s);
        setTasks(t.filter((x) => x.nodeId === id));
        setSkillIds(d.node.skills);
        setDraft({});
      })
      .catch((err: unknown) => setMessage(err instanceof Error ? err.message : "Ошибка"));
  };

  useEffect(load, [id]);

  if (!detail) return <div className="p-4 text-sm">{message ?? "Загрузка…"}</div>;
  const { node, effective } = detail;

  // Local edits live in `draft`; the server value is shown until the user saves.
  const field = <K extends keyof NodeFields>(key: K, fallback: NodeFields[K]) =>
    (key in draft ? draft[key] : fallback) as NodeFields[K];
  const set = <K extends keyof NodeFields>(key: K, value: NodeFields[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.updateNode(id, draft);
      setMessage("Сохранено");
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Ошибка");
    }
  };

  const saveSkills = async () => {
    try {
      await api.setNodeSkills(id, skillIds);
      setMessage("Скилы сохранены");
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Ошибка");
    }
  };

  const toggleAutopilot = async () => {
    const on = !(node.autopilotUntil && node.autopilotUntil > Date.now());
    await api.updateNode(id, { autopilot: on }).catch(() => setMessage("Не удалось изменить автопилот"));
    load();
  };

  const addChild = async (e: FormEvent) => {
    e.preventDefault();
    if (!child.name) return;
    const created = await api.createNode({ kind: child.kind, name: child.name, parentId: id }).catch((err: unknown) => {
      setMessage(err instanceof Error ? err.message : "Ошибка");
      return null;
    });
    if (created) navigate(`/nodes/${created.id}`);
  };

  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!task.title || !task.prompt) return;
    try {
      const created = await api.createTask(id, task);
      navigate(`/tasks/${created.id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Ошибка");
    }
  };

  const removeNode = async () => {
    if (!window.confirm(`Удалить «${node.name}»?`)) return;
    try {
      await api.deleteNode(id);
      navigate("/");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Ошибка");
    }
  };

  const jumpMode = field("jumpMode", node.jumpMode) as JumpMode;
  const otherNodes = all.filter((n) => n.id !== id);
  const autopilotOn = !!(node.autopilotUntil && node.autopilotUntil > Date.now());

  return (
    <div className="max-w-2xl space-y-6 p-4">
      <header>
        <h1 className="text-lg font-semibold">{node.name}</h1>
        <p className="text-xs text-neutral-500">{KIND_LABEL[node.kind]}</p>
      </header>

      {detail.routeError && <p className="text-sm text-red-600">Маршрут: {detail.routeError}</p>}
      {effective && <p className="text-sm">Маршрут: <code>{routeLine(detail, all)}</code></p>}

      <form onSubmit={save} className="grid grid-cols-2 gap-3 text-sm">
        <label className="col-span-2">
          Имя
          <input className={inputClass} value={field("name", node.name) ?? ""} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label>
          ОС
          <select className={inputClass} value={field("os", node.os)} onChange={(e) => set("os", e.target.value as OsKind)}>
            {OSES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label>
          Адрес {node.kind === "vm" && <span className="text-red-600">*</span>}
          <input className={inputClass} value={field("address", node.address) ?? ""} onChange={(e) => set("address", e.target.value || null)} />
        </label>
        <label>
          Порт (наследуется, 22 по умолчанию)
          <input
            className={inputClass}
            type="number"
            placeholder={String(effective?.port ?? 22)}
            value={field("port", node.port) ?? ""}
            onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)}
          />
        </label>
        <label>
          Пользователь
          <input
            className={inputClass}
            placeholder={effective?.user ? `наследуется: ${effective.user}` : "наследуется"}
            value={field("user", node.user) ?? ""}
            onChange={(e) => set("user", e.target.value || null)}
          />
        </label>
        <label>
          Оболочка
          <select
            className={inputClass}
            value={field("shell", node.shell) ?? ""}
            onChange={(e) => set("shell", (e.target.value || null) as ShellKind | null)}
          >
            <option value="">{`наследуется (${effective?.shell ?? "bash"})`}</option>
            {SHELLS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="col-span-2">
          Кред {effective?.credentialFrom && !node.credentialId && <span className="text-neutral-500">(от: {effective.credentialFrom})</span>}
          <select
            className={inputClass}
            value={field("credentialId", node.credentialId) ?? ""}
            onChange={(e) => set("credentialId", e.target.value || null)}
          >
            <option value="">наследовать</option>
            {creds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
        </label>

        <fieldset className="col-span-2 space-y-1 rounded border border-neutral-200 p-2">
          <legend className="px-1">Подключение через бастион</legend>
          {(["inherit", "direct", "via"] as JumpMode[]).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input type="radio" name="jump" checked={jumpMode === mode} onChange={() => set("jumpMode", mode)} />
              {mode === "inherit" && `Наследовать${effective ? ` (сейчас: ${effective.jumpChain.length ? "через бастион" : "напрямую"}${effective.jumpFrom ? ` от ${effective.jumpFrom}` : ""})` : ""}`}
              {mode === "direct" && "Напрямую"}
              {mode === "via" && "Через узел"}
            </label>
          ))}
          {jumpMode === "via" && (
            <select
              className={inputClass}
              value={field("jumpNodeId", node.jumpNodeId) ?? ""}
              onChange={(e) => set("jumpNodeId", e.target.value || null)}
            >
              <option value="">выберите узел</option>
              {otherNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-neutral-500">Каждый хоп использует свой ключ хоста (TOFU).</p>
        </fieldset>

        <label className="col-span-2">
          Заметки
          <textarea className={inputClass} rows={3} value={field("notes", node.notes) ?? ""} onChange={(e) => set("notes", e.target.value || null)} />
        </label>

        <div className="col-span-2 flex gap-2">
          <button className={buttonClass} disabled={Object.keys(draft).length === 0}>
            Сохранить
          </button>
          <button type="button" className="rounded border px-3 py-1.5" onClick={() => setDraft({})}>
            Отменить
          </button>
          <button type="button" className="rounded border px-3 py-1.5 text-red-700" onClick={removeNode}>
            Удалить узел
          </button>
          {node.kind !== "vm" && (
            <button type="button" className="rounded border px-3 py-1.5" onClick={() => api.resetHostKey(id).then(() => setMessage("Ключ хоста сброшен"))}>
              Сбросить ключ хоста
            </button>
          )}
        </div>
      </form>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Скилы</h2>
        {skills.map((s) => (
          <label key={s.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={skillIds.includes(s.id)}
              onChange={(e) =>
                setSkillIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))
              }
            />
            {s.name} <span className="text-neutral-500">{effective?.skillSources[s.id] ? `от: ${effective.skillSources[s.id]}` : ""}</span>
          </label>
        ))}
        <button className={buttonClass} onClick={saveSkills}>
          Сохранить скилы
        </button>
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Автопилот</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autopilotOn} onChange={toggleAutopilot} />
          Не спрашивать подтверждения для обычных команд (4 часа, dangerous по-прежнему спрашивает)
        </label>
        {autopilotOn && node.autopilotUntil && (
          <p className="text-xs text-neutral-500">до {new Date(node.autopilotUntil).toLocaleTimeString()}</p>
        )}
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Дочерний узел</h2>
        <form onSubmit={addChild} className="flex gap-2">
          <select className={inputClass} value={child.kind} onChange={(e) => setChild({ ...child, kind: e.target.value as NodeKind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input className={inputClass} placeholder="Имя" value={child.name} onChange={(e) => setChild({ ...child, name: e.target.value })} />
          <button className={buttonClass}>Добавить</button>
        </form>
        <a className="text-xs underline" href={`/import?parent=${id}`}>
          Импорт сюда…
        </a>
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Задачи</h2>
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <a className="underline" href={`/tasks/${t.id}`}>
                {t.title}
              </a>{" "}
              <span className="text-neutral-500">{t.status}</span>
            </li>
          ))}
        </ul>
        <form onSubmit={createTask} className="space-y-2">
          <input className={inputClass} placeholder="Заголовок задачи" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
          <textarea className={inputClass} rows={2} placeholder="Что сделать" value={task.prompt} onChange={(e) => setTask({ ...task, prompt: e.target.value })} />
          <button className={buttonClass}>Новая задача</button>
        </form>
      </section>

      {message && <p className="text-sm text-neutral-700">{message}</p>}
    </div>
  );
}
