import { useCallback, useEffect, useState } from "react";
import { createBrowserRouter, Link, Navigate, Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { Building2, PanelLeftOpen, Settings, Upload } from "lucide-react";
import type { InventoryNode, NodeKind } from "@sysadm/shared";
import { api } from "./api";
import AddNodeDialog from "./components/AddNodeDialog";
import OpencodeUpdate from "./components/OpencodeUpdate";
import { ResizeHandle, usePaneWidth } from "./components/ResizeHandle";
import SettingsDialog, { type SettingsTarget } from "./components/SettingsDialog";
import Sidebar from "./components/Sidebar";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import ChatPage from "./pages/ChatPage";
import PluginPage from "./pages/PluginPage";
import LoginPage from "./pages/LoginPage";
import TasksPage from "./pages/TasksPage";
import { useTaskNotifications } from "./lib/notify";
import { useEnabledPlugins } from "./plugins/useEnabledPlugins";
import { t as tr } from "./i18n/app";

const COLLAPSED_KEY = "sysadm.sidebarCollapsed";

type AddTarget = { parent: InventoryNode | null; kind?: NodeKind } | null;

// Three panes like OpenChamber: inventory on the left, the routed page (chat + its right panel) in the middle.
function Layout() {
  const [add, setAdd] = useState<AddTarget>(null);
  const [settings, setSettings] = useState<SettingsTarget>(null);
  const sidebar = usePaneWidth("sysadm.sidebarWidth", 288, 220);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      return !c;
    });
  }, []);
  // Ctrl/Cmd+B, as in editors and OpenChamber.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);
  useTaskNotifications();
  const plugins = useEnabledPlugins();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen overflow-hidden">
        {collapsed ? (
          <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={toggleSidebar} aria-label={tr("sidebar.showPanel")}>
                  <PanelLeftOpen />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{tr("sidebar.showPanel")} · Ctrl+B</TooltipContent>
            </Tooltip>
            <Link to="/" className="mt-1" aria-label="SysAiAdm Station">
              <img src="/logo.svg" alt="" className="size-6" />
            </Link>
            <Button variant="ghost" size="icon-sm" className="mt-auto" onClick={() => setSettings({ section: "general" })} aria-label={tr("sidebar.settings")}>
              <Settings />
            </Button>
          </div>
        ) : (
          <>
            <Sidebar
              width={sidebar.width}
              onAdd={setAdd}
              onImport={(parent) => setSettings({ section: "transfer", parent })}
              onExport={(parent) => setSettings({ section: "transfer", parent })}
              onSettings={() => setSettings({ section: "general" })}
              onCollapse={toggleSidebar}
            />
            <ResizeHandle edge="right" pane={sidebar} />
          </>
        )}
        <main className="flex min-w-0 flex-1">
          <Outlet context={{ setAdd, setSettings } satisfies LayoutContext} />
        </main>
      </div>
      <AddNodeDialog target={add} onClose={() => setAdd(null)} />
      <SettingsDialog target={settings} onSection={(section) => setSettings({ section })} onClose={() => setSettings(null)} />
      <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
        <OpencodeUpdate />
        {plugins.map((p) => p.Notice && <p.Notice key={p.id} />)}
      </div>
    </TooltipProvider>
  );
}

export interface LayoutContext {
  setAdd: (t: AddTarget) => void;
  setSettings: (t: SettingsTarget) => void;
}

function Home() {
  const [count, setCount] = useState<number | null>(null);
  const { setAdd, setSettings } = useOutletContext<LayoutContext>();
  useEffect(() => {
    api.tree().then((t) => setCount(t.length)).catch(() => setCount(null));
  }, []);
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="max-w-md text-center">
        <img src="/logo.svg" alt="" className="mx-auto mb-3 size-14" />
        <p className="mb-6 text-xs tracking-wide text-muted-foreground">SysAiAdm Station · {tr("brand.tagline")}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{count === 0 ? tr("home.startTitle") : tr("home.pickTitle")}</h1>
        {count === 0 && (
          <>
            <p className="mt-2 text-sm text-muted-foreground">{tr("home.startHint")}</p>
            <div className="mt-5 flex justify-center gap-2">
              <Button onClick={() => setAdd({ parent: null })}>
                <Building2 /> {tr("home.addCompany")}
              </Button>
              <Button variant="outline" onClick={() => setSettings({ section: "transfer" })}>
                <Upload /> {tr("home.import")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Old /tasks/:id links (API docs, notifications) land on the node-scoped chat.
function TaskRedirect() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    api
      .task(id)
      .then((r) => navigate(`/nodes/${r.task.nodeId}/tasks/${id}`, { replace: true }))
      .catch(() => navigate("/tasks", { replace: true }));
  }, [id, navigate]);
  return null;
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: "nodes/:id", element: <ChatPage /> },
      { path: "nodes/:id/tasks/:taskId", element: <ChatPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "plugins/:id", element: <PluginPage /> },
      { path: "tasks/:id", element: <TaskRedirect /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
