import { createBrowserRouter, Link, Navigate, Outlet, useNavigate } from "react-router";
import { api } from "./api";
import InventoryTree from "./components/InventoryTree";
import ImportPage from "./pages/ImportPage";
import LoginPage from "./pages/LoginPage";
import NodePage from "./pages/NodePage";
import SettingsPage from "./pages/SettingsPage";
import SystemPage from "./pages/SystemPage";
import TaskPage from "./pages/TaskPage";
import TasksPage from "./pages/TasksPage";

// Sidebar with the inventory tree on the left, the routed page on the right.
function Layout() {
  const navigate = useNavigate();
  const logout = async () => {
    await api.logout().catch(() => {});
    navigate("/login", { replace: true });
  };
  return (
    <div className="flex h-screen">
      <aside className="flex w-72 shrink-0 flex-col gap-3 border-r p-3">
        <nav className="flex gap-3 text-sm">
          <Link className="font-semibold" to="/">
            sysadm
          </Link>
          <Link to="/tasks">Задачи</Link>
          <Link to="/import">Импорт</Link>
          <Link to="/settings">Настройки</Link>
          <Link to="/system">Система</Link>
        </nav>
        <InventoryTree />
        <button className="text-left text-xs text-neutral-500 underline" onClick={logout}>
          Выйти
        </button>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function Home() {
  return <p className="p-4 text-sm text-neutral-500">Выберите узел в дереве слева.</p>;
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: "nodes/:id", element: <NodePage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TaskPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "import", element: <ImportPage /> },
      { path: "system", element: <SystemPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
