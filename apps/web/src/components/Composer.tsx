import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowUp, Bot, Check, ChevronDown, Cpu, Square, Zap } from "lucide-react";
import type { AgentInfo, ModelInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { matchCommands } from "@/lib/commands";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { fmtTime } from "@/i18n";
import { t } from "@/i18n/app";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

const MODEL_KEY = "sysadm.model";
const AGENT_KEY = "sysadm.agent";
const COLLAPSED_KEY = "sysadm.modelGroupsCollapsed";

function loadSaved<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled: the choice holds for this page load only.
  }
}

// The last picked model and agent survive reloads; they are UI preferences, not secrets.
export function useComposerChoice() {
  const [model, setModel] = useState<ModelRef | null>(() => loadSaved<ModelRef>(MODEL_KEY));
  const [agent, setAgent] = useState<string | null>(() => loadSaved<string>(AGENT_KEY));
  return {
    model,
    agent,
    setModel: (m: ModelRef | null) => {
      setModel(m);
      save(MODEL_KEY, m);
    },
    setAgent: (a: string | null) => {
      setAgent(a);
      save(AGENT_KEY, a);
    },
  };
}

function ModelPicker({ models, value, onChange, locked }: { models: ModelInfo[]; value: ModelRef | null; onChange: (m: ModelRef | null) => void; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = models.find((m) => m.providerID === value?.providerID && m.id === value?.modelID);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q) && !m.providerID.includes(q)) continue;
      map.set(m.providerID, [...(map.get(m.providerID) ?? []), m]);
    }
    return [...map.entries()];
  }, [models, query]);
  const searching = query.trim() !== "";
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = loadSaved<unknown>(COLLAPSED_KEY);
    return Array.isArray(saved) ? saved : [];
  });
  const toggle = (provider: string) => {
    const next = collapsed.includes(provider) ? collapsed.filter((p) => p !== provider) : [...collapsed, provider];
    setCollapsed(next);
    save(COLLAPSED_KEY, next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={locked} className="max-w-56 text-muted-foreground" title={locked ? t("composer.modelLocked") : undefined}>
          <Cpu />
          <span className="truncate">{current?.name ?? (value ? value.modelID : t("composer.defaultModel"))}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <input
          autoFocus
          className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
          placeholder={t("composer.findModel")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-80 overflow-y-auto p-1">
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            {t("composer.modelFromConfig")}
            {!value && <Check className="ml-auto size-3.5" />}
          </button>
          {groups.map(([provider, list]) => {
            // A search shows every match, so collapsed groups open while the query is set.
            const shut = !searching && collapsed.includes(provider);
            return (
              <div key={provider}>
                <button
                  aria-expanded={!shut}
                  className="flex w-full items-center gap-1 rounded-md px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(provider)}
                >
                  <ChevronDown className={cn("size-3 transition-transform", shut && "-rotate-90")} />
                  <span className="truncate">{provider}</span>
                  <span className="ml-auto normal-case tracking-normal">{list.length}</span>
                </button>
                {!shut &&
                  list.map((m) => {
                    const selected = m.providerID === value?.providerID && m.id === value?.modelID;
                    return (
                      <button
                        key={`${m.providerID}/${m.id}`}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => {
                          onChange({ providerID: m.providerID, modelID: m.id });
                          setOpen(false);
                        }}
                      >
                        <span className="truncate">{m.name}</span>
                        {m.limit?.context ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{Math.round(m.limit.context / 1000)}k</span> : null}
                        {selected && <Check className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {models.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{t("composer.noModels")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentPicker({ agents, value, onChange, locked }: { agents: AgentInfo[]; value: string | null; onChange: (a: string | null) => void; locked: boolean }) {
  const current = agents.find((a) => a.id === value || a.name === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={locked} className="text-muted-foreground" title={locked ? t("composer.agentLocked") : undefined}>
          <Bot />
          {current?.name ?? value ?? t("composer.defaultAgent")}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t("composer.agent")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          {t("composer.default")} {!value && <Check className="ml-auto" />}
        </DropdownMenuItem>
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => onChange(a.id)} className="flex-col items-start gap-0">
            <span className="flex w-full items-center">
              {a.name} {value === a.id && <Check className="ml-auto" />}
            </span>
            {a.description && <span className="line-clamp-2 text-xs text-muted-foreground">{a.description}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutopilotToggle({ until, onChange }: { until: number | null; onChange: (on: boolean) => void }) {
  const on = !!until && until > Date.now();
  const title = on ? t("composer.autopilotOn", { time: fmtTime(until) }) : t("composer.autopilotOff");
  return (
    <Button variant="ghost" size="sm" onClick={() => onChange(!on)} aria-pressed={on} title={title} className={cn(on ? "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive" : "text-muted-foreground")}>
      <Zap className={cn(on && "fill-current")} />
      {t("composer.autopilot")}
    </Button>
  );
}

interface Props {
  placeholder: string;
  models: ModelInfo[];
  agents: AgentInfo[];
  model: ModelRef | null;
  agent: string | null;
  onModel: (m: ModelRef | null) => void;
  onAgent: (a: string | null) => void;
  // Model and agent are fixed once the task exists: the API sets them only at creation.
  locked: boolean;
  running: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  // Autopilot: until this time the node runs commands without asking. Absent when the node is unknown.
  autopilotUntil?: number | null;
  onAutopilot?: (on: boolean) => void;
  // Slash commands offered while the first word starts with "/".
  commands?: Array<{ name: string; description: string }>;
}

function SlashMenu({ items, active, onPick }: { items: Array<{ name: string; description: string }>; active: number; onPick: (name: string) => void }) {
  return (
    <div role="listbox" className="absolute inset-x-2 bottom-full mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
      {items.map((c, i) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={i === active}
          // mousedown keeps focus in the textarea
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c.name);
          }}
          className={cn("flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm", i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
        >
          <span className="shrink-0 font-mono text-primary">/{c.name}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
        </button>
      ))}
    </div>
  );
}

export default function Composer(props: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const { sendKey } = usePrefs();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = /^\/(\S*)$/.exec(text)?.[1];
  const slash = useMemo(
    () => (query === undefined || dismissed === text ? [] : matchCommands(props.commands ?? [], query).slice(0, 30)),
    [query, dismissed, text, props.commands],
  );
  const pick = (name: string) => {
    setText(`/${name} `);
    setActive(0);
  };

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    if (await props.onSend(value)) setText("");
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.length && !e.nativeEvent.isComposing) {
      const at = Math.min(active, slash.length - 1);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((at + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(slash[at].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(text);
        return;
      }
    }
    const mod = e.ctrlKey || e.metaKey;
    const sends = sendKey === "enter" ? !e.shiftKey && !mod : mod;
    if (e.key === "Enter" && sends && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/60">
      {slash.length > 0 && <SlashMenu items={slash} active={Math.min(active, slash.length - 1)} onPick={pick} />}
      <textarea
        className="block max-h-60 min-h-[3.25rem] w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        placeholder={props.placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <AgentPicker agents={props.agents} value={props.agent} onChange={props.onAgent} locked={props.locked} />
        <ModelPicker models={props.models} value={props.model} onChange={props.onModel} locked={props.locked} />
        {props.onAutopilot && <AutopilotToggle until={props.autopilotUntil ?? null} onChange={props.onAutopilot} />}
        <span className="ml-auto" />
        {props.running && (
          <Button size="sm" variant="destructive" onClick={props.onStop} title={t("composer.stopHint")}>
            <Square className="fill-current" />
            {t("composer.stop")}
          </Button>
        )}
        <Button size="icon-sm" className={cn("rounded-full")} disabled={!text.trim() || busy} onClick={send} aria-label={t("composer.send")}>
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
