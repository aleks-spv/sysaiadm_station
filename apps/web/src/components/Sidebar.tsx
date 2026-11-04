import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Archive,
  Building2,
  ChevronRight,
  Download,
  Folder,
  ListTodo,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Server,
  Settings,
  Shield,
  Sun,
  Trash2,
  Upload,
  Zap,
} from "lucide-react";
import type { InventoryNode, NodeKind, Task } from "@sysadm/shared";
import { api, subscribeEvents } from "@/api";
import type { NodeAction } from "@/plugins";
import { useEnabledPlugins } from "@/plugins/useEnabledPlugins";
import { KIND_LABEL } from "@/components/AddNodeDialog";
import { OS_ICON } from "@/components/OsIcons";
import RenameDialog from "@/components/RenameDialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, errorText } from "@/lib/utils";
import { applyTheme, currentTheme, resolvedTheme } from "@/theme";
import { lang, LANGS, setLang } from "@/i18n";
import { t as tr } from "@/i18n/app";

const KIND_ICON: Record<NodeKind, typeof Server> = { company: Building2, group: Folder, hypervisor: Server, vm: Monitor };
// One hue per kind so the tree reads at a glance; lighter shades on the dark theme.
const KIND_COLOR: Record<NodeKind, string> = {
  company: "text-primary",
  group: "text-sky-600 dark:text-sky-400",
  hypervisor: "text-violet-600 dark:text-violet-400",
  vm: "text-emerald-600 dark:text-emerald-400",
};
const TREE_ERRORS = ["IS_JUMP_HOST", "TASK_RUNNING", "MOVE_CYCLE", "PROTECTED"] as const;
const DRAG_TYPE = "application/x-sysadm-node";
const TASKS_SHOWN = 8;

export const STATUS_DOT: Record<Task["status"], string> = {
  running: "bg-primary animate-pulse",
  waiting_permission: "bg-amber-400",
  idle: "bg-emerald-500/80",
  stopped: "bg-muted-foreground/40",
  error: "bg-destructive",
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

interface Props {
  width: number;
  onAdd: (target: { parent: InventoryNode | null; kind?: NodeKind }) => void;
  onImport: (parentId: string | null) => void;
  onExport: (nodeId: string) => void;
  onSettings: () => void;
  onCollapse: () => void;
}

export default function Sidebar({ width, onAdd, onImport, onExport, onSettings, onCollapse }: Props) {
  const { pathname } = useLocation();
  const plugins = useEnabledPlugins();
  const pluginLinks = plugins.filter((p) => p.Page && p.placement !== "settings");
  const nodeActions = plugins.flatMap((p) => p.nodeActions ?? []);
  const [action, setAction] = useState<{ node: InventoryNode; Dialog: NodeAction["Dialog"] } | null>(null);
  const [renaming, setRenaming] = useState<InventoryNode | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const { id: selectedId, taskId } = useParams();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<InventoryNode[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(currentTheme);
  // Nodes whose task list is folded; remembered so a long list stays folded across reloads.
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("sysadm.foldedTasks") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [showAll, setShowAll] = useState(false);
  useEffect(() => localStorage.setItem("sysadm.foldedTasks", JSON.stringify([...folded])), [folded]);

  const reload = useCallback(() => {
    Promise.all([api.tree(), api.tasks()])
      .then(([tree, taskList]) => {
        setNodes(tree);
        setTasks(taskList);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
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
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // True when `id` is `ancestorId` or lies below it.
  const inside = (id: string | null, ancestorId: string): boolean => {
    for (let cur = id; cur; cur = byId.get(cur)?.parentId ?? null) if (cur === ancestorId) return true;
    return false;
  };
  const parents = useMemo(() => new Set(nodes.map((n) => n.parentId)), [nodes]);
  const jumpHosts = useMemo(() => new Set(nodes.map((n) => n.jumpNodeId).filter((x): x is string => !!x)), [nodes]);
  const tasksByNode = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) map.set(t.nodeId, [...(map.get(t.nodeId) ?? []), t]);
    return map;
  }, [tasks]);
  const waiting = tasks.filter((t) => t.status === "waiting_permission").length;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const treeError = (err: unknown) => {
    const code = errorText(err);
    return (TREE_ERRORS as readonly string[]).includes(code) ? tr(`sidebar.err.${code as (typeof TREE_ERRORS)[number]}`) : code;
  };

  const remove = async (node: InventoryNode) => {
    const count = nodes.filter((n) => inside(n.id, node.id)).length;
    const question = count > 1 ? tr("sidebar.confirmDeleteTree", { name: node.name, count }) : tr("node.confirmDelete", { name: node.name });
    if (!window.confirm(question)) return;
    try {
      await api.deleteNode(node.id, count > 1);
      if (selectedId && inside(selectedId, node.id)) navigate("/");
      reload();
    } catch (err) {
      setError(treeError(err));
    }
  };

  // Drop targets: any non-VM node outside the dragged subtree that is not already its parent.
  const canDrop = (target: InventoryNode) =>
    !!dragId && target.kind !== "vm" && target.id !== byId.get(dragId)?.parentId && !inside(target.id, dragId);

  const move = async (target: InventoryNode) => {
    const id = dragId;
    setDragId(null);
    setDropId(null);
    if (!id || !canDrop(target)) return;
    try {
      await api.moveNode(id, target.id);
      setOpen((prev) => new Set(prev).add(target.id));
      reload();
    } catch (err) {
      setError(treeError(err));
    }
  };

  const archive = async (t: Task) => {
    try {
      await api.archiveTask(t.id);
      if (t.id === taskId) navigate(`/nodes/${t.nodeId}`);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    navigate("/login", { replace: true });
  };

  const switchTheme = () => {
    const next = resolvedTheme(theme) === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <header className="flex h-12 items-center gap-2 px-3">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img src="/logo.svg" alt="" className="size-6" />
          <span className="truncate">
            SysAiAdm <span className="font-normal text-muted-foreground">Station</span>
          </span>
        </Link>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={tr("sidebar.add")}>
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{tr("sidebar.add")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => onAdd({ parent: null })}>
              <Building2 className={KIND_COLOR.company} /> {tr("kind.company")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onImport(null)}>
              <Upload /> {tr("sidebar.import")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label={tr("sidebar.hidePanel")}>
              <PanelLeftClose />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr("sidebar.hidePanel")} · Ctrl+B</TooltipContent>
        </Tooltip>
      </header>

      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/60 px-2.5 text-sm focus-within:ring-2 focus-within:ring-sidebar-ring">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            placeholder={tr("sidebar.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tr("sidebar.infra")}</div>
      {error && <p className="px-3 text-xs text-destructive">{error}</p>}

      <ul className="flex-1 overflow-y-auto px-2 pb-2 text-sm">
        {rows.map(({ node, depth }) => {
          const Icon = (node.kind === "vm" && OS_ICON[node.os]) || KIND_ICON[node.kind];
          const hasKids = parents.has(node.id);
          const nodeTasks = tasksByNode.get(node.id) ?? [];
          const running = nodeTasks.some((t) => t.status === "running");
          const waitingHere = nodeTasks.some((t) => t.status === "waiting_permission");
          const selected = node.id === selectedId;
          const autopilot = !!node.autopilotUntil && node.autopilotUntil > Date.now();
          return (
            <li key={node.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
              <div
                style={{ paddingLeft: depth * 12 }}
                draggable={node.kind !== "company"}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, node.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(node.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropId(null);
                }}
                onDragOver={(e) => {
                  if (!canDrop(node)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropId(node.id);
                }}
                onDragLeave={() => setDropId((prev) => (prev === node.id ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  void move(node);
                }}
                className={cn(
                  "group flex h-7 items-center gap-1 rounded-md pr-1 transition-colors",
                  selected && !taskId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                  dragId === node.id && "opacity-50",
                  dropId === node.id && "bg-primary/15 ring-1 ring-primary",
                )}
              >
                <button
                  className={cn("grid size-5 shrink-0 place-items-center text-muted-foreground", (!hasKids || query) && "invisible")}
                  onClick={() => toggle(node.id)}
                  aria-label={open.has(node.id) ? tr("sidebar.collapse") : tr("sidebar.expand")}
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", open.has(node.id) && "rotate-90")} />
                </button>
                <Link to={`/nodes/${node.id}`} draggable={false} className="flex min-w-0 flex-1 items-center gap-2" title={`${KIND_LABEL[node.kind]}${node.address ? ` · ${node.address}` : ""}`}>
                  <Icon className={cn("size-3.5 shrink-0", KIND_COLOR[node.kind])} />
                  <span className={cn("truncate", node.kind === "company" && "font-medium")}>{node.name}</span>
                </Link>
                {autopilot && <Zap className="size-3 shrink-0 text-destructive" aria-label={tr("sidebar.autopilot")} />}
                {jumpHosts.has(node.id) && <Shield className="size-3 shrink-0 text-muted-foreground" aria-label={tr("sidebar.jump")} />}
                {waitingHere ? (
                  <span className="size-2 shrink-0 rounded-full bg-amber-400" title={tr("sidebar.waiting")} />
                ) : running ? (
                  <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" title={tr("sidebar.working")} />
                ) : null}
                {node.kind === "vm" ? (
                  <Link
                    to={`/nodes/${node.id}`}
                    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover:opacity-100"
                    aria-label={tr("sidebar.newTask")}
                    title={tr("sidebar.newTask")}
                  >
                    <MessageSquarePlus className="size-3.5" />
                  </Link>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label={tr("sidebar.addInside")}
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuItem onSelect={() => onAdd({ parent: node, kind: "group" })}>
                        <Folder className={KIND_COLOR.group} /> {tr("kind.group")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onAdd({ parent: node, kind: "hypervisor" })}>
                        <Server className={KIND_COLOR.hypervisor} /> {tr("kind.hypervisor")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onAdd({ parent: node, kind: "vm" })}>
                        <Monitor className={KIND_COLOR.vm} /> {tr("kind.vm")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onImport(node.id)}>
                        <Upload /> {tr("sidebar.importHere")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => navigate(`/nodes/${node.id}`)}>
                    <MessageSquarePlus /> {node.kind === "vm" || node.kind === "hypervisor" ? tr("sidebar.newTask") : tr("sidebar.open")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => setRenaming(node)}>
                    <Pencil /> {tr("rename.menu")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onExport(node.id)}>
                    <Download /> {tr("sidebar.export")}
                  </ContextMenuItem>
                  <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => void remove(node)}>
                    <Trash2 /> {tr("sidebar.delete")}
                  </ContextMenuItem>
                  {nodeActions.some((a) => !a.kinds || a.kinds.includes(node.kind)) && <ContextMenuSeparator />}
                  {nodeActions
                    .filter((a) => !a.kinds || a.kinds.includes(node.kind))
                    .map(({ id, label, icon: ActionIcon, Dialog }) => (
                      <ContextMenuItem key={id} onSelect={() => setAction({ node, Dialog })}>
                        <ActionIcon /> {label}
                      </ContextMenuItem>
                    ))}
                </ContextMenuContent>
              </ContextMenu>

              {selected && (
                <ul className="py-0.5" style={{ paddingLeft: depth * 12 + 20 }}>
                  {nodeTasks.length > 0 && (
                    <li>
                      <button
                        onClick={() => fold(node.id)}
                        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight className={cn("size-3 transition-transform", !folded.has(node.id) && "rotate-90")} />
                        {tr("sidebar.tasks", { count: nodeTasks.length })}
                      </button>
                    </li>
                  )}
                  {!folded.has(node.id) &&
                    (showAll ? nodeTasks : nodeTasks.slice(0, TASKS_SHOWN)).map((t) => {
                      const live = t.status === "running" || t.status === "waiting_permission";
                      return (
                        <li key={t.id} className="group/task relative">
                          <Link
                            to={`/nodes/${node.id}/tasks/${t.id}`}
                            className={cn(
                              "flex h-7 items-center gap-2 rounded-md pr-7 pl-2 text-xs transition-colors",
                              t.id === taskId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
                            )}
                          >
                            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{t.title}</span>
                            <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", STATUS_DOT[t.status])} />
                          </Link>
                          {!live && (
                            <button
                              onClick={() => void archive(t)}
                              className="absolute top-1 right-1 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover/task:opacity-100 focus-visible:opacity-100"
                              aria-label={tr("sidebar.archive")}
                              title={tr("sidebar.archive")}
                            >
                              <Archive className="size-3" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  {!folded.has(node.id) && nodeTasks.length > TASKS_SHOWN && (
                    <li>
                      <button onClick={() => setShowAll((v) => !v)} className="block px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                        {showAll ? tr("sidebar.less") : tr("sidebar.more", { count: nodeTasks.length - TASKS_SHOWN })}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
        {nodes.length === 0 && !error && (
          <li className="px-2 py-6 text-center text-xs text-muted-foreground">
            {tr("sidebar.empty")}
            <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => onAdd({ parent: null })}>
              <Plus /> {tr("sidebar.addCompany")}
            </Button>
          </li>
        )}
        {nodes.length > 0 && rows.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted-foreground">{tr("sidebar.notFound")}</li>}
      </ul>

      {pluginLinks.length > 0 && (
        <nav className="flex flex-col gap-0.5 border-t border-sidebar-border p-2">
          {pluginLinks.map(({ id, title, icon: Icon }) => (
            <Link
              key={id}
              to={`/plugins/${id}`}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-sidebar-accent/60",
                pathname === `/plugins/${id}` && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4" /> {title}
            </Link>
          ))}
        </nav>
      )}

      <footer className="flex items-center gap-1 border-t border-sidebar-border p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild className="relative">
              <Link to="/tasks" aria-label={tr("sidebar.allTasks")}>
                <ListTodo />
                {waiting > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400" />}
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {tr("sidebar.allTasks")}
            {waiting > 0 ? tr("sidebar.waitingCount", { count: waiting }) : ""}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onSettings} aria-label={tr("sidebar.settings")}>
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr("sidebar.settings")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={switchTheme} aria-label={tr("sidebar.theme")}>
              {resolvedTheme(theme) === "dark" ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{resolvedTheme(theme) === "dark" ? tr("sidebar.lightTheme") : tr("sidebar.darkTheme")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs uppercase"
              onClick={() => setLang(LANGS[(LANGS.findIndex((l) => l.id === lang) + 1) % LANGS.length].id)}
              aria-label={tr("sidebar.language")}
            >
              {lang}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr("sidebar.language")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={logout} aria-label={tr("sidebar.logout")}>
              <LogOut />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr("sidebar.logout")}</TooltipContent>
        </Tooltip>
      </footer>
      {action && <action.Dialog node={action.node} onClose={() => setAction(null)} />}
      {renaming && <RenameDialog node={renaming} onClose={() => setRenaming(null)} onDone={reload} />}
    </aside>
  );
}
