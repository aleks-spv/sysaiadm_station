import type { ComponentType } from "react";
import { Activity, Archive, ArrowLeftRight, Bot, Boxes, Cpu, DatabaseBackup, FileClock, FileJson, Globe, Info, KeyRound, KeySquare, Palette, Puzzle, Sparkles, SquareSlash, type LucideIcon } from "lucide-react";
import SystemPanel from "@/components/SystemPanel";
import { AuditTab, CredentialsTab, TokensTab } from "@/components/settings/AdminSections";
import AboutSection from "@/components/settings/AboutSection";
import AgentsSection from "@/components/settings/AgentsSection";
import CommandsSection from "@/components/settings/CommandsSection";
import GeneralSection from "@/components/settings/GeneralSection";
import ModelsSection from "@/components/settings/ModelsSection";
import OpencodeConfigSection from "@/components/settings/OpencodeConfigSection";
import PluginsSection from "@/components/settings/PluginsSection";
import ProvidersSection from "@/components/settings/ProvidersSection";
import SkillsSection from "@/components/settings/SkillsSection";
import TransferSection from "@/components/settings/TransferSection";
import BackupsSection from "@/components/settings/BackupsSection";
import WebSearchSection from "@/components/settings/WebSearchSection";
import TaskArchiveSection from "@/components/settings/TaskArchiveSection";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/settings";
import { useEnabledPlugins } from "@/plugins/useEnabledPlugins";
import { cn } from "@/lib/utils";

export type SettingsTarget = { section: string; parent?: string | null } | null;

interface Section {
  id: string;
  title: string;
  icon: LucideIcon;
  Body: ComponentType<{ parent?: string | null }>;
}

const GROUPS: Array<{ title: string; sections: Section[] }> = [
  {
    title: t("dialog.groupInterface"),
    sections: [{ id: "general", title: t("dialog.sectionGeneral"), icon: Palette, Body: GeneralSection }],
  },
  {
    title: t("dialog.groupAgent"),
    sections: [
      { id: "providers", title: t("dialog.sectionProviders"), icon: Cpu, Body: ProvidersSection },
      { id: "models", title: t("dialog.sectionModels"), icon: Boxes, Body: ModelsSection },
      { id: "agents", title: t("dialog.sectionAgents"), icon: Bot, Body: AgentsSection },
      { id: "skills", title: t("dialog.sectionSkills"), icon: Sparkles, Body: SkillsSection },
      { id: "commands", title: t("dialog.sectionCommands"), icon: SquareSlash, Body: CommandsSection },
      { id: "websearch", title: t("dialog.sectionWebSearch"), icon: Globe, Body: WebSearchSection },
      { id: "opencode", title: t("dialog.sectionOpencode"), icon: FileJson, Body: OpencodeConfigSection },
    ],
  },
  {
    title: t("dialog.groupSysadm"),
    sections: [
      { id: "plugins", title: t("dialog.sectionPlugins"), icon: Puzzle, Body: PluginsSection },
      { id: "tasks", title: t("dialog.sectionTasks"), icon: Archive, Body: TaskArchiveSection },
      { id: "credentials", title: t("dialog.sectionCredentials"), icon: KeyRound, Body: CredentialsTab },
      { id: "tokens", title: t("dialog.sectionTokens"), icon: KeySquare, Body: TokensTab },
      { id: "transfer", title: t("dialog.sectionTransfer"), icon: ArrowLeftRight, Body: TransferSection },
      { id: "backups", title: t("dialog.sectionBackups"), icon: DatabaseBackup, Body: BackupsSection },
      { id: "system", title: t("dialog.sectionSystem"), icon: Activity, Body: SystemPanel },
      { id: "audit", title: t("dialog.sectionAudit"), icon: FileClock, Body: AuditTab },
      { id: "about", title: t("dialog.sectionAbout"), icon: Info, Body: AboutSection },
    ],
  },
];


// Gear popup: section list on the left, the section on the right.
export default function SettingsDialog({ target, onSection, onClose }: { target: SettingsTarget; onSection: (id: string) => void; onClose: () => void }) {
  // Enabled plugins whose page belongs in settings (WireGuard) become sections of their own group.
  const pluginSections: Section[] = useEnabledPlugins()
    .filter((p) => p.Page && p.placement === "settings")
    .map((p) => ({ id: `plugin:${p.id}`, title: p.title, icon: p.icon, Body: p.Page! }));
  const groups = pluginSections.length ? [...GROUPS, { title: t("dialog.groupPlugins"), sections: pluginSections }] : GROUPS;
  const all = groups.flatMap((g) => g.sections);
  const current = all.find((s) => s.id === target?.section) ?? all[0]!;
  const { Body } = current;
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <nav className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <DialogTitle className="px-2 text-base">{t("dialog.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("dialog.description")}</DialogDescription>
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-0.5">
              <span className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{g.title}</span>
              {g.sections.map(({ id, title, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => onSection(id)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                    id === current.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" /> {title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6 text-sm">
          <h2 className="mb-4 text-lg font-semibold">{current.title}</h2>
          {/* Grows to the dialog height, so list/editor sections can stretch; longer ones still scroll. */}
          <div className="flex flex-1 flex-col">
            <Body parent={target?.parent} />
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
