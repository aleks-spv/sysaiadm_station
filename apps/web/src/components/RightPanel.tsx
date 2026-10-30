import { useEffect, useState } from "react";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import type { InventoryNode, Task } from "@sysadm/shared";
import { api, type NodeDetail } from "@/api";
import NodeSettings from "@/components/NodeSettings";
import { ResizeHandle, usePaneWidth } from "@/components/ResizeHandle";
import { useEnabledPlugins } from "@/plugins/useEnabledPlugins";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ToolCall, Usage } from "@/lib/messages";
import { cn, errorText, fieldClass } from "@/lib/utils";
import { fmtDateTime } from "@/i18n";
import { t as tr } from "@/i18n/app";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2.5" title={hint}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function ContextTab({ task, usage, contextLimit, calls }: { task: Task | null; usage: Usage; contextLimit: number | null; calls: ToolCall[] }) {
  if (!task) return <p className="text-xs text-muted-foreground">{tr("panel.noTask")}</p>;
  const pct = contextLimit ? Math.min(100, Math.round((usage.lastContext / contextLimit) * 100)) : null;
  const failed = calls.filter((c) => c.status === "error").length;
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">{tr("panel.context")}</span>
          <span className="font-mono">
            {fmt(usage.lastContext)}
            {contextLimit ? ` / ${fmt(contextLimit)}` : ""}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${pct !== null && pct > 80 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct ?? 0}%` }} />
        </div>
        {pct !== null && <div className="text-right text-[11px] text-muted-foreground">{pct}%</div>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label={tr("panel.input")} value={fmt(usage.input)} />
        <Stat label={tr("panel.output")} value={fmt(usage.output)} />
        <Stat label={tr("panel.cacheRead")} value={fmt(usage.cacheRead)} />
        <Stat label={tr("panel.reasoning")} value={fmt(usage.reasoning)} />
        <Stat label={tr("panel.cost")} value={`$${usage.cost.toFixed(4)}`} />
        <Stat label={tr("panel.commandCount")} value={failed ? `${calls.length} (${failed} ✗)` : String(calls.length)} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{tr("panel.model")}</dt>
        <dd className="truncate font-mono">{usage.model ? `${usage.model.providerID}/${usage.model.id}` : "—"}</dd>
        <dt className="text-muted-foreground">{tr("panel.agent")}</dt>
        <dd className="font-mono">{usage.agent ?? "—"}</dd>
        <dt className="text-muted-foreground">{tr("panel.created")}</dt>
        <dd>{fmtDateTime(task.createdAt)}</dd>
      </dl>
    </div>
  );
}

function CommandsTab({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return <p className="text-xs text-muted-foreground">{tr("panel.noCommands")}</p>;
  return (
    <ol className="space-y-1.5">
      {calls.map((c) => (
        <li key={c.id} className="rounded-lg border bg-card/50 p-2">
          <div className="flex items-start gap-1.5">
            {c.status === "completed" ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
            ) : c.status === "error" ? (
              <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            ) : (
              <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
            )}
            <code className="min-w-0 break-all font-mono text-xs">{c.command || c.name}</code>
          </div>
        </li>
      ))}
    </ol>
  );
}

const NOTES_HINT: Record<InventoryNode["kind"], { title: string; hint: string }> = {
  company: { title: tr("panel.notesCompany"), hint: tr("panel.notesCompanyHint") },
  group: { title: tr("panel.notesGroup"), hint: tr("panel.notesGroupHint") },
  hypervisor: { title: tr("panel.notesHypervisor"), hint: tr("panel.notesHypervisorHint") },
  vm: { title: tr("panel.notesVm"), hint: tr("panel.notesVmHint") },
};

function NotesTab({ detail, onChanged }: { detail: NodeDetail; onChanged: () => void }) {
  const { node } = detail;
  const [text, setText] = useState(node.notes ?? "");
  const [agentsMd, setAgentsMd] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setText(node.notes ?? "");
    api.agentsMd(node.id).then((r) => setAgentsMd(r.content)).catch(() => setAgentsMd(""));
    // Only a change of the stored notes resets the editor; unrelated reloads keep what is being typed.
  }, [node.id, node.notes]);

  const save = async () => {
    try {
      await api.updateNode(node.id, { notes: text.trim() ? text : null });
      setMessage(tr("panel.notesSaved"));
      onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const hint = NOTES_HINT[node.kind];
  return (
    <div className="space-y-3 text-sm">
      <div>
        <h3 className="font-medium">{hint.title}</h3>
        <p className="text-xs text-muted-foreground">{hint.hint}</p>
      </div>
      <textarea className={`${fieldClass} min-h-48 resize-y font-mono text-xs leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Markdown" />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={text === (node.notes ?? "")} onClick={save}>
          {tr("common.save")}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground">{tr("panel.finalAgentsMd")}</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t p-2.5 font-mono text-[11px] leading-relaxed">{agentsMd || tr("panel.notBuilt")}</pre>
      </details>
    </div>
  );
}

interface Props {
  detail: NodeDetail;
  nodes: InventoryNode[];
  task: Task | null;
  usage: Usage;
  calls: ToolCall[];
  contextLimit: number | null;
  onChanged: () => void;
}

export default function RightPanel({ detail, nodes, task, usage, calls, contextLimit, onChanged }: Props) {
  const host = detail.node.kind === "vm" || detail.node.kind === "hypervisor";
  const pane = usePaneWidth("sysadm.rightWidth", 320, 260, 720);
  const tools = useEnabledPlugins()
    .flatMap((p) => p.panelTools ?? [])
    .filter((t) => !t.kinds || t.kinds.includes(detail.node.kind));
  // Active tool replaces the tabs; every tool opened once stays mounted (a terminal keeps its session) until the node changes.
  const [tool, setTool] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTool(null);
    setOpened(new Set());
  }, [detail.node.id]);
  // Opening a task shows its context, a bare node its notes.
  const [tab, setTab] = useState(task ? "context" : "notes");
  useEffect(() => setTab(task ? "context" : "notes"), [!!task]);
  const openTool = (id: string) => {
    setTool((cur) => (cur === id ? null : id));
    setOpened((prev) => new Set(prev).add(id));
  };
  return (
    <>
    <ResizeHandle edge="left" pane={pane} />
    <aside style={{ width: pane.width }} className="flex shrink-0 flex-col border-l bg-sidebar/50">
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-12 items-center gap-1 border-b px-2">
          <TabsList className="min-w-0 flex-1" onPointerDown={() => setTool(null)}>
            <TabsTrigger value="context">{tr("panel.context")}</TabsTrigger>
            <TabsTrigger value="commands">{tr("panel.tabCommands")}</TabsTrigger>
            <TabsTrigger value="notes">{host ? tr("panel.tabNotes") : "AGENTS.md"}</TabsTrigger>
            <TabsTrigger value="node">{tr("panel.tabNode")}</TabsTrigger>
          </TabsList>
          {tools.map(({ id, title, icon: Icon }) => (
            <Button key={id} variant={tool === id ? "secondary" : "ghost"} size="icon-sm" title={title} aria-label={title} aria-pressed={tool === id} onClick={() => openTool(id)}>
              <Icon />
            </Button>
          ))}
        </div>
        {tools
          .filter((t) => opened.has(t.id))
          .map(({ id, Panel }) => (
            <div key={id} className={cn("min-h-0 flex-1 flex-col", tool === id ? "flex" : "hidden")}>
              <Panel node={detail.node} active={tool === id} />
            </div>
          ))}
        <div className={cn("min-h-0 flex-1 overflow-y-auto p-3", tool && "hidden")}>
          <TabsContent value="context">
            <ContextTab task={task} usage={usage} contextLimit={contextLimit} calls={calls} />
          </TabsContent>
          <TabsContent value="commands">
            <CommandsTab calls={calls} />
          </TabsContent>
          <TabsContent value="notes">
            <NotesTab detail={detail} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="node">
            <NodeSettings detail={detail} nodes={nodes} onChanged={onChanged} />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
    </>
  );
}
