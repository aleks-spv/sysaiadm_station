import { useEffect, useState } from "react";
import { Circle, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import type { InventoryNode, Task } from "@sysadm/shared";
import { api, type NodeDetail } from "@/api";
import NodeSettings from "@/components/NodeSettings";
import { ResizeHandle, usePaneWidth } from "@/components/ResizeHandle";
import { useEnabledPlugins } from "@/plugins/useEnabledPlugins";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { latestTodos, type ToolCall, type Usage } from "@/lib/messages";
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

// The agent's todo list.
function Plan({ calls }: { calls: ToolCall[] }) {
  const todos = latestTodos(calls);
  if (!todos?.length) return <p className="text-xs text-muted-foreground">{tr("panel.noPlan")}</p>;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="space-y-2 rounded-lg border bg-card/50 p-2.5">
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{tr("panel.tabPlan")}</span>
          <span className="font-mono">
            {done}/{todos.length}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
      </div>
      <ol className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className={cn("flex items-start gap-2 rounded-md px-1.5 py-1 text-sm", t.status === "in_progress" && "bg-primary/10")}>
            {t.status === "completed" ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            ) : t.status === "in_progress" ? (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            ) : t.status === "cancelled" ? (
              <CircleX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("min-w-0 break-words", (t.status === "completed" || t.status === "cancelled") && "text-muted-foreground", t.status === "cancelled" && "line-through")}>
              {t.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
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
    <div className="flex h-full min-h-0 flex-col gap-3 text-sm">
      <div>
        <h3 className="font-medium">{hint.title}</h3>
        <p className="text-xs text-muted-foreground">{hint.hint}</p>
      </div>
      <textarea className={`${fieldClass} min-h-48 flex-1 resize-none font-mono text-xs leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Markdown" />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={text === (node.notes ?? "")} onClick={save}>
          {tr("common.save")}
        </Button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
      <details className="shrink-0 rounded-lg border">
        <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground">{tr("panel.finalAgentsMd")}</summary>
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap border-t p-2.5 font-mono text-[11px] leading-relaxed">{agentsMd || tr("panel.notBuilt")}</pre>
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
  const pane = usePaneWidth("sysadm.rightWidth", 320, 260);
  const tools = useEnabledPlugins()
    .flatMap((p) => p.panelTools ?? [])
    .filter((t) => !t.kinds || t.kinds.includes(detail.node.kind));
  // Plugin tools are tabs too ("tool:<id>"); every tool opened once stays mounted (a terminal keeps its session)
  // until the node changes.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // Opening a task shows its context, a bare node its notes.
  const [tab, setTab] = useState(task ? "context" : "notes");
  useEffect(() => setTab(task ? "context" : "notes"), [!!task]);
  useEffect(() => {
    setOpened(new Set());
    setTab((t) => (t.startsWith("tool:") ? (task ? "context" : "notes") : t));
  }, [detail.node.id]);
  const tool = tab.startsWith("tool:") ? tab.slice(5) : null;
  const selectTab = (value: string) => {
    setTab(value);
    if (value.startsWith("tool:")) setOpened((prev) => new Set(prev).add(value.slice(5)));
  };
  return (
    <>
    <ResizeHandle edge="left" pane={pane} />
    <aside style={{ width: pane.width }} className="flex shrink-0 flex-col border-l bg-sidebar/50">
      <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-12 items-center border-b px-2">
          <TabsList className="min-w-0 flex-1">
            <TabsTrigger value="context">{tr("panel.context")}</TabsTrigger>
            <TabsTrigger value="plan">{tr("panel.tabPlan")}</TabsTrigger>
            <TabsTrigger value="notes">{host ? tr("panel.tabNotes") : "AGENTS.md"}</TabsTrigger>
            <TabsTrigger value="node">{tr("panel.tabNode")}</TabsTrigger>
            {tools.map(({ id, title, icon: Icon }) => (
              <TabsTrigger key={id} value={`tool:${id}`} title={title} aria-label={title} className="flex-none px-2">
                <Icon />
              </TabsTrigger>
            ))}
          </TabsList>
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
          <TabsContent value="plan">
            {task ? <Plan calls={calls} /> : <p className="text-xs text-muted-foreground">{tr("panel.noTask")}</p>}
          </TabsContent>
          <TabsContent value="notes" className="h-full">
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
