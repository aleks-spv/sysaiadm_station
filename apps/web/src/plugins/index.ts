import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { CalendarClock, Gauge, ShieldCheck, SquareTerminal } from "lucide-react";
import type { InventoryNode, NodeKind } from "@sysadm/shared";
import { t } from "@/i18n/app";
import RtkPage from "../../../../plugins/rtk/web/RtkPage";
import RtkUpdate from "../../../../plugins/rtk/web/RtkUpdate";
import SchedulerPage from "../../../../plugins/scheduler/web/SchedulerPage";
import ScheduleDialog from "../../../../plugins/scheduler/web/ScheduleDialog";
import TerminalPanel from "../../../../plugins/terminal/web/TerminalPanel";
import WireguardPage from "../../../../plugins/wireguard/web/WireguardPage";

// Item in a node's right-click menu; the dialog opens over the app.
export interface NodeAction {
  id: string;
  label: string;
  icon: LucideIcon;
  kinds?: NodeKind[];
  Dialog: ComponentType<{ node: InventoryNode; onClose: () => void }>;
}

// Icon in the right panel header; the panel replaces the tabs while active and stays mounted per node.
export interface PanelTool {
  id: string;
  title: string;
  icon: LucideIcon;
  kinds?: NodeKind[];
  Panel: ComponentType<{ node: InventoryNode; active: boolean }>;
}

// UI half of a SysAiAdm Station plugin (<repo>/plugins/<id>/web); the id matches the server plugin.
// A plugin with a Page gets a sidebar entry and /plugins/<id>, or a settings section with placement "settings".
export interface WebPlugin {
  id: string;
  title: string;
  icon: LucideIcon;
  Page?: ComponentType;
  placement?: "sidebar" | "settings";
  nodeActions?: NodeAction[];
  panelTools?: PanelTool[];
  // Rendered in the bottom-right corner stack (update cards and similar); returns null when there is nothing to say.
  Notice?: ComponentType;
}

const HOSTS: NodeKind[] = ["hypervisor", "vm"];

export const WEB_PLUGINS: WebPlugin[] = [
  { id: "wireguard", title: "VPN (WireGuard)", icon: ShieldCheck, Page: WireguardPage, placement: "settings" },
  { id: "rtk", title: t("plugin.rtk"), icon: Gauge, Page: RtkPage, Notice: RtkUpdate },
  {
    id: "scheduler",
    title: t("plugin.scheduler"),
    icon: CalendarClock,
    Page: SchedulerPage,
    nodeActions: [{ id: "schedule", label: t("plugin.schedule"), icon: CalendarClock, kinds: HOSTS, Dialog: ScheduleDialog }],
  },
  {
    id: "terminal",
    title: t("plugin.terminal"),
    icon: SquareTerminal,
    panelTools: [{ id: "terminal", title: t("plugin.terminal"), icon: SquareTerminal, kinds: HOSTS, Panel: TerminalPanel }],
  },
];
