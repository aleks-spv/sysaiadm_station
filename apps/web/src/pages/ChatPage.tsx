import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ChevronRight, PanelRight, Square } from "lucide-react";
import type { InventoryNode, Task } from "@sysadm/shared";
import type { ChatCommand } from "@sysadm/shared";
import { api, subscribeEvents, type AgentInfo, type ModelInfo, type NodeDetail, type PendingPermission } from "@/api";
import { KIND_LABEL } from "@/components/AddNodeDialog";
import Composer, { useComposerChoice } from "@/components/Composer";
import PermissionPrompt from "@/components/PermissionPrompt";
import RightPanel from "@/components/RightPanel";
import { STATUS_DOT } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import NodeCard from "@/components/NodeCard";
import Transcript from "@/components/Transcript";
import { BUILTIN_COMMANDS, expandCommand, parseSlash } from "@/lib/commands";
import { parseMessages, toolCalls, usageOf } from "@/lib/messages";
import { CHAT_WIDTH, usePrefs } from "@/lib/prefs";
import { cn, errorText } from "@/lib/utils";
import { t } from "@/i18n/app";

// shortcut: the server pushes only status changes, so a live task is re-read on a timer; stream text deltas over SSE if this gets heavy.
const LIVE_POLL_MS = 1000;
const PANEL_KEY = "sysadm.rightPanel";

const STATUS_LABEL: Record<Task["status"], string> = {
  running: t("status.running"),
  idle: t("status.idle"),
  waiting_permission: t("status.waiting_permission"),
  stopped: t("status.stopped"),
  error: t("status.error"),
};

const SUGGESTIONS = [t("chat.suggest1"), t("chat.suggest2"), t("chat.suggest3"), t("chat.suggest4")];

function pathTo(nodes: InventoryNode[], id: string): InventoryNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: InventoryNode[] = [];
  let cur = byId.get(id);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

export default function ChatPage() {
  const { id = "", taskId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [nodes, setNodes] = useState<InventoryNode[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<unknown[]>([]);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [panel, setPanel] = useState(() => localStorage.getItem(PANEL_KEY) !== "0");
  const choice = useComposerChoice();
  const prefs = usePrefs();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const loadNode = useCallback(() => {
    Promise.all([api.node(id), api.tree()])
      .then(([d, tree]) => {
        setDetail(d);
        setNodes(tree);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [id]);

  const loadTask = useCallback(() => {
    if (!taskId) return;
    api
      .task(taskId)
      .then((r) => {
        setTask(r.task);
        setMessages(r.messages);
      })
      .catch((err: unknown) => setError(errorText(err)));
    api.pendingPermissions(taskId).then(setPending).catch(() => setPending([]));
  }, [taskId]);

  useEffect(() => {
    Promise.all([api.models(), api.agents(), api.hiddenModels().catch(() => [] as string[])])
      .then(([m, a, hiddenList]) => {
        const hidden = new Set(hiddenList);
        const enabled = m.data.filter((x) => x.enabled !== false);
        setModels((enabled.length ? enabled : m.data).filter((x) => !hidden.has(`${x.providerID}/${x.id}`)));
        setAgents(a.data.filter((x) => !x.hidden && x.mode !== "subagent"));
      })
      .catch(() => {});
    api
      .commands()
      .then((r) => setCommands(r.commands))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setError(null);
    loadNode();
    return subscribeEvents((ev) => {
      if (ev.type === "tree.updated" || ev.type === "resync") loadNode();
    });
  }, [loadNode]);

  useEffect(() => {
    setTask(null);
    setMessages([]);
    setPending([]);
    stick.current = true;
    loadTask();
    return subscribeEvents((ev) => {
      if ((ev.type === "task.status" && ev.taskId === taskId) || ev.type === "resync") loadTask();
    });
  }, [taskId, loadTask]);

  const live = task?.status === "running" || task?.status === "waiting_permission";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(loadTask, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, loadTask]);

  const items = useMemo(() => parseMessages(messages), [messages]);
  const usage = useMemo(() => usageOf(messages), [messages]);
  const calls = useMemo(() => toolCalls(items), [items]);
  const contextLimit = models.find((m) => m.providerID === usage.model?.providerID && m.id === usage.model?.id)?.limit?.context ?? null;

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending.length]);

  const togglePanel = () => {
    setPanel((p) => {
      localStorage.setItem(PANEL_KEY, p ? "0" : "1");
      return !p;
    });
  };

  // Returns the error text, null on success.
  const collect = async (): Promise<string | null> => {
    setCollecting(true);
    setFactsError(null);
    try {
      await api.collectFacts(id);
      loadNode();
      return null;
    } catch (err) {
      const message = errorText(err);
      setFactsError(message);
      return message;
    } finally {
      setCollecting(false);
    }
  };

  const send = async (input: string): Promise<boolean> => {
    setError(null);
    let text = input;
    let agent = choice.agent;
    const slash = parseSlash(input);
    if (slash?.name === "init") {
      if (!detail || !["vm", "hypervisor"].includes(detail.node.kind)) {
        setError(t("chat.initHostOnly"));
        return false;
      }
      const failed = await collect();
      if (failed) setError(`/init: ${failed}`);
      else if (taskId) navigate(`/nodes/${id}`);
      return !failed;
    }
    if (slash) {
      const cmd = commands.find((c) => c.name === slash.name);
      if (!cmd) {
        setError(t("chat.noCommand", { name: slash.name }));
        return false;
      }
      text = expandCommand(cmd.template, slash.args);
      if (cmd.agent) agent = cmd.agent;
    }
    try {
      if (taskId) {
        await api.promptTask(taskId, text);
        stick.current = true;
        loadTask();
      } else {
        const title = (slash ? input.trim() : text).split("\n")[0].slice(0, 80);
        const created = await api.createTask(id, {
          title,
          prompt: text,
          // A remembered agent that was since disabled or deleted falls back to the configured default.
          ...(agent && agents.some((a) => a.id === agent) ? { agent } : {}),
          ...(choice.model ? { model: choice.model } : {}),
        });
        navigate(`/nodes/${id}/tasks/${created.id}`);
      }
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const stop = () => taskId && api.stopTask(taskId).then(loadTask).catch((err: unknown) => setError(errorText(err)));

  const reply = async (requestID: string, decision: "once" | "always" | "reject") => {
    if (!taskId) return;
    try {
      await api.replyPermission(taskId, requestID, decision);
      loadTask();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!detail) return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">{error ?? t("common.loading")}</div>;
  const { node } = detail;
  const host = node.kind === "vm" || node.kind === "hypervisor";
  const path = pathTo(nodes, node.id);
  // Only the first pending request is shown: Enter/Esc act on it, so two prompts would conflict.
  const first = pending[0];

  return (
    <div className="flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <nav className="flex min-w-0 items-center gap-1 text-sm">
            {path.map((n, i) => (
              <span key={n.id} className="flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                <button
                  onClick={() => navigate(`/nodes/${n.id}`)}
                  className={cn("truncate hover:text-foreground", i === path.length - 1 && !task ? "font-medium" : "text-muted-foreground")}
                >
                  {n.name}
                </button>
              </span>
            ))}
            {task && (
              <span className="flex min-w-0 items-center gap-1">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{task.title}</span>
              </span>
            )}
          </nav>
          {node.address && <span className="hidden shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground md:block">{node.address}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {task && (
              <span className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", STATUS_DOT[task.status])} />
                {STATUS_LABEL[task.status]}
              </span>
            )}
            {live && (
              <Button size="sm" variant="outline" onClick={stop}>
                <Square className="fill-current" /> {t("common.stop")}
              </Button>
            )}
            <Button size="icon-sm" variant={panel ? "secondary" : "ghost"} onClick={togglePanel} aria-label={t("chat.panel")} title={t("chat.panelHint")}>
              <PanelRight />
            </Button>
          </div>
        </header>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className={cn("mx-auto flex flex-col gap-4 px-6 py-6", CHAT_WIDTH[prefs.chatWidth])}>
            {!taskId && host && (
              <div className="flex flex-col gap-6">
                <NodeCard facts={detail.facts} busy={collecting} error={factsError} onCollect={() => void collect()} />
                <div className="flex flex-col items-center gap-4 text-center">
                  <div>
                    <h1 className="text-xl font-semibold tracking-tight">{t("chat.heading", { name: node.name })}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {KIND_LABEL[node.kind]} · {node.os}
                      {detail.effective ? ` · ${detail.effective.jumpChain.length ? t("common.viaJump") : t("common.direct")}` : ""}. {t("chat.confirmHint")}
                    </p>
                  </div>
                  <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} onClick={() => void send(s)} className="rounded-xl border bg-card/50 px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                        {s}
                      </button>
                    ))}
                  </div>
                  {commands.length > 0 && (
                    <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
                      {commands.slice(0, 8).map((c) => (
                        <button
                          key={c.name}
                          onClick={() => void send(`/${c.name}`)}
                          title={c.description}
                          className="rounded-full border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                        >
                          /{c.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {!taskId && !host && (
              <div className="flex flex-col items-center gap-3 pt-[12vh] text-center">
                <h1 className="text-2xl font-semibold tracking-tight">{node.name}</h1>
                <p className="max-w-md text-sm text-muted-foreground">
                  {t("chat.notHost", { kind: KIND_LABEL[node.kind] })}
                  {node.kind === "company" && t("chat.companyNotes")}
                </p>
              </div>
            )}
            <Transcript items={items} live={live} working={live && !first} />
          </div>
        </div>

        {(host || taskId) && (
          <div className={cn("mx-auto w-full space-y-2 px-6 pb-4", CHAT_WIDTH[prefs.chatWidth])}>
            {first && <PermissionPrompt permission={first} onReply={(d) => reply(first.id, d)} />}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Composer
              placeholder={taskId ? t("chat.followUp") : t("chat.newTask", { name: node.name })}
              models={models}
              agents={agents}
              model={taskId ? (usage.model ? { providerID: usage.model.providerID, modelID: usage.model.id } : null) : choice.model}
              agent={taskId ? usage.agent : choice.agent}
              onModel={choice.setModel}
              onAgent={choice.setAgent}
              locked={!!taskId}
              running={live}
              onSend={send}
              commands={[...BUILTIN_COMMANDS, ...commands]}
              onStop={stop}
              {...(host && {
                autopilotUntil: node.autopilotUntil,
                onAutopilot: (on: boolean) =>
                  api
                    .updateNode(id, { autopilot: on })
                    .then(loadNode)
                    .catch((err: unknown) => setError(errorText(err))),
              })}
            />
          </div>
        )}
      </section>

      {panel && <RightPanel detail={detail} nodes={nodes} task={task} usage={usage} calls={calls} contextLimit={contextLimit} onChanged={loadNode} />}
    </div>
  );
}
