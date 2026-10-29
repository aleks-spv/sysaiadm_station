import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { InventoryNode, Task } from "@sysadm/shared";
import { api, subscribeEvents } from "../api";

const KIND_LABEL: Record<InventoryNode["kind"], string> = {
  company: "Компания",
  group: "Группа",
  hypervisor: "Гипервизор",
  vm: "ВМ",
};

interface Row {
  node: InventoryNode;
  depth: number;
}

// Builds the visible rows: collapsed branches hide their children unless the search matches below them.
function flatten(nodes: InventoryNode[], open: Set<string>, query: string): Row[] {
  const byParent = new Map<string | null, InventoryNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  const q = query.trim().toLowerCase();
  const matches = (n: InventoryNode) => !q || n.name.toLowerCase().includes(q) || (n.address ?? "").toLowerCase().includes(q);

  // A subtree is kept when the node or any descendant matches, so the path to a hit stays visible.
  const keep = new Map<string, boolean>();
  const visit = (n: InventoryNode): boolean => {
    const kids = byParent.get(n.id) ?? [];
    const childHit = kids.map(visit).some(Boolean);
    const hit = matches(n) || childHit;
    keep.set(n.id, hit);
    return hit;
  };
  for (const root of byParent.get(null) ?? []) visit(root);

  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of byParent.get(parent) ?? []) {
      if (!keep.get(n.id)) continue;
      rows.push({ node: n, depth });
      // Search forces the path open; otherwise only nodes the user expanded show children.
      if (q || open.has(n.id)) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export default function InventoryTree() {
  const { id: selectedId } = useParams();
  const [nodes, setNodes] = useState<InventoryNode[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([api.tree(), api.tasks()])
      .then(([tree, taskList]) => {
        setNodes(tree);
        setTasks(taskList);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  useEffect(() => {
    reload();
    // Status changes and tree edits from any page refresh the sidebar without polling.
    return subscribeEvents((ev) => {
      if (ev.type === "task.status" || ev.type === "tree.updated" || ev.type === "resync") reload();
    });
  }, [reload]);

  // Every ancestor of the open node is expanded so the selection is visible on load.
  useEffect(() => {
    if (!selectedId) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const next = new Set<string>();
    let cur = byId.get(selectedId)?.parentId ?? null;
    while (cur) {
      next.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    setOpen((prev) => new Set([...prev, ...next]));
  }, [selectedId, nodes]);

  const rows = useMemo(() => flatten(nodes, open, query), [nodes, open, query]);

  // Per node: how many tasks run, and whether one waits for approval.
  const taskBadge = useMemo(() => {
    const map = new Map<string, { running: number; waiting: number }>();
    for (const t of tasks) {
      const entry = map.get(t.nodeId) ?? { running: 0, waiting: 0 };
      if (t.status === "running") entry.running += 1;
      if (t.status === "waiting_permission") entry.waiting += 1;
      map.set(t.nodeId, entry);
    }
    return map;
  }, [tasks]);

  const jumpHosts = useMemo(() => new Set(nodes.map((n) => n.jumpNodeId).filter((x): x is string => !!x)), [nodes]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col gap-2">
      <input
        className="rounded border border-neutral-300 px-2 py-1 text-sm"
        placeholder="Поиск по имени или адресу"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <ul className="flex-1 overflow-auto text-sm">
        {rows.map(({ node, depth }) => {
          const hasKids = nodes.some((n) => n.parentId === node.id);
          const badge = taskBadge.get(node.id);
          const selected = node.id === selectedId;
          return (
            <li key={node.id} style={{ paddingLeft: depth * 14 }} className="flex items-center gap-1 py-0.5">
              {hasKids && !query ? (
                <button className="w-4 text-neutral-500" onClick={() => toggle(node.id)} aria-label="раскрыть">
                  {open.has(node.id) ? "▾" : "▸"}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <Link
                to={`/nodes/${node.id}`}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 ${selected ? "bg-neutral-200" : "hover:bg-neutral-100"}`}
              >
                <span className="truncate">{node.name}</span>
                <span className="shrink-0 text-xs text-neutral-500">{KIND_LABEL[node.kind]}</span>
                {badge?.running ? <span className="shrink-0 rounded bg-blue-100 px-1 text-xs">задач: {badge.running}</span> : null}
                {badge?.waiting ? <span className="shrink-0 rounded bg-amber-200 px-1 text-xs">ждёт подтверждения</span> : null}
                {node.autopilotUntil && node.autopilotUntil > Date.now() ? (
                  <span className="shrink-0 rounded bg-red-100 px-1 text-xs">автопилот</span>
                ) : null}
                {jumpHosts.has(node.id) ? <span className="shrink-0 rounded bg-neutral-300 px-1 text-xs">бастион</span> : null}
              </Link>
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-neutral-500">Ничего не найдено</li>}
      </ul>
    </div>
  );
}
