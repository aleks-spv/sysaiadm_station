import { useEffect, useMemo, useState } from "react";
import { Brain, Check, ChevronRight, CircleCheck, CircleX, Copy, LoaderCircle, MessageCircleQuestion, ShieldQuestion, Sparkles, TerminalSquare } from "lucide-react";
import Markdown from "@/components/Markdown";
import { groupItems, type ChatItem, type StepItem, type ToolCall } from "@/lib/messages";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { t as tr } from "@/i18n/app";

// Re-renders every second while something runs, for live durations.
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function duration(ms: number): string {
  if (ms < 1000) return tr("steps.ms", { n: Math.max(0, Math.round(ms)) });
  const s = ms / 1000;
  if (s < 60) return tr("steps.s", { n: s < 10 ? s.toFixed(1) : Math.round(s) });
  return tr("steps.min", { m: Math.floor(s / 60), s: Math.round(s % 60) });
}

const running = (c: ToolCall) => c.status === "running" || c.status === "streaming";
const failed = (c: ToolCall) => c.status === "error" || (c.exitCode !== null && c.exitCode !== 0);

function toolLabel(call: ToolCall): { icon: typeof TerminalSquare; text: string } {
  if (call.name === "remote_exec") return { icon: TerminalSquare, text: call.command };
  if (call.name === "skill") {
    const name = /"name":"([^"]+)"/.exec(call.command)?.[1];
    return { icon: Sparkles, text: tr("steps.skill", { name: name ?? "" }).trim() };
  }
  if (call.name === "question") return { icon: MessageCircleQuestion, text: tr("steps.question") };
  return { icon: TerminalSquare, text: `${call.name} ${call.command}`.trim() };
}

// First meaningful line of reasoning, without markdown marks: the collapsed view of a thought.
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/[*_`#>]/g, "").trim();
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={tr("common.copy")}
      aria-label={tr("common.copy")}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/step:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function ToolStep({ call, expand }: { call: ToolCall; expand: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isRunning = running(call);
  const bad = failed(call);
  const now = useNow(isRunning);
  const shown = open ?? (expand || bad);
  const hasOutput = !!(call.stdout || call.stderr || call.notes.length);
  const end = call.finished ?? (isRunning ? now : null);
  const took = call.started && end ? end - call.started : null;
  const { icon: Icon, text } = toolLabel(call);
  // Unparsed output of a failed call (e.g. a denied command) is the error itself.
  const errorOnly = call.status === "error" && call.exitCode === null;

  return (
    <li className="group/step">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={hasOutput ? shown : undefined}
        onClick={() => hasOutput && setOpen(!shown)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && hasOutput && (e.preventDefault(), setOpen(!shown))}
        className={cn("flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs", hasOutput && "cursor-pointer hover:bg-accent/50")}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", shown && "rotate-90", !hasOutput && "invisible")} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--code-size)]" title={text}>
          {text}
        </code>
        {call.raw && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">raw</span>}
        {call.exitCode !== null && call.exitCode !== 0 && <span className="rounded bg-destructive/15 px-1 font-mono text-[10px] text-destructive">exit {call.exitCode}</span>}
        <CopyButton text={call.command} />
        {took !== null && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{duration(took)}</span>}
        {isRunning ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : bad ? (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
        )}
      </div>
      {shown && hasOutput && (
        <div className="mt-1 mb-2 ml-5 overflow-hidden rounded-lg border bg-muted/40 font-mono text-[length:var(--code-size)] leading-relaxed">
          {call.stdout && !errorOnly && <pre className="max-h-96 overflow-auto px-3 py-2 break-all whitespace-pre-wrap">{call.stdout}</pre>}
          {(call.stderr || errorOnly) && (
            <pre className={cn("max-h-64 overflow-auto bg-destructive/5 px-3 py-2 break-all whitespace-pre-wrap text-destructive/90", call.stdout && !errorOnly && "border-t")}>
              {errorOnly ? call.output : call.stderr}
            </pre>
          )}
          {call.notes.map((n) => (
            <p key={n} className="border-t px-3 py-1 font-sans text-[11px] text-muted-foreground">
              {n.replace(/^\[|\]$/g, "")}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

function ReasoningStep({ item, expand, streaming }: { item: Extract<StepItem, { kind: "reasoning" }>; expand: boolean; streaming: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (expand || streaming);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!shown))}
        className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/50"
      >
        <ChevronRight className={cn("mt-0.5 size-3 shrink-0 transition-transform", shown && "rotate-90")} />
        <Brain className="mt-px size-3.5 shrink-0" />
        {!shown && <span className="min-w-0 flex-1 truncate italic">{firstLine(item.text)}</span>}
        {shown && (
          <div className={cn("min-w-0 flex-1", streaming && "max-h-60 overflow-y-auto")} onClick={(e) => e.stopPropagation()}>
            <Markdown text={item.text} className="text-xs leading-relaxed text-muted-foreground" />
          </div>
        )}
      </div>
    </li>
  );
}

function stepsSummary(steps: StepItem[]): string {
  const calls = steps.flatMap((s) => (s.kind === "tool" ? [s.call] : []));
  const parts: string[] = [];
  if (calls.length) parts.push(tr("steps.commands", { count: calls.length }));
  const bad = calls.filter(failed).length;
  if (bad) parts.push(tr("steps.failed", { count: bad }));
  if (!calls.length) parts.push(tr("steps.reasoning"));
  const starts = steps.map((s) => (s.kind === "tool" ? s.call.started : s.started)).filter((t): t is number => t !== null);
  const ends = steps.map((s) => (s.kind === "tool" ? s.call.finished : s.finished)).filter((t): t is number => t !== null);
  if (starts.length && ends.length) parts.push(duration(Math.max(...ends) - Math.min(...starts)));
  return parts.join(" · ");
}

function Steps({ steps, active, working }: { steps: StepItem[]; active: boolean; working: boolean }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? active;
  const last = steps[steps.length - 1];
  const current = last.kind === "tool" && running(last.call) ? toolLabel(last.call).text : tr("steps.thinking");

  return (
    <div className="-mx-1.5">
      <button
        type="button"
        onClick={() => setOpen(!shown)}
        aria-expanded={shown}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {active && working ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : active ? (
          <ShieldQuestion className="size-3.5 shrink-0 text-primary" />
        ) : (
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", shown && "rotate-90")} />
        )}
        <span className={cn("truncate", active && working && "shimmer")}>{active ? (working ? current : tr("steps.waiting")) : stepsSummary(steps)}</span>
      </button>
      {shown && (
        <ol className="mt-0.5 ml-[13px] border-l pl-2">
          {steps.map((s, i) =>
            s.kind === "tool" ? (
              <ToolStep key={s.id} call={s.call} expand={prefs.expandOutput} />
            ) : (
              <ReasoningStep key={s.id} item={s} expand={prefs.expandReasoning} streaming={active && i === steps.length - 1 && s.finished === null} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function Block({ item }: { item: Exclude<ChatItem, StepItem> }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{item.text}</div>
        </div>
      );
    case "text":
      return <Markdown text={item.text} className="text-sm" />;
    case "error":
      return <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{item.text}</div>;
  }
}

// The task conversation: answers as markdown, the work between them as one collapsible run of steps.
// A live run stays open and shows what runs now; finished runs fold into a one-line summary.
export default function Transcript({ items, live, working }: { items: ChatItem[]; live: boolean; working: boolean }) {
  const blocks = useMemo(() => groupItems(items), [items]);
  const lastIsSteps = blocks[blocks.length - 1]?.kind === "steps";
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "steps" ? (
          <Steps key={b.id} steps={b.steps} active={live && i === blocks.length - 1} working={working} />
        ) : (
          <Block key={b.id} item={b} />
        ),
      )}
      {working && !lastIsSteps && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
          <span className="shimmer">{tr("steps.thinking")}</span>
        </div>
      )}
    </>
  );
}
