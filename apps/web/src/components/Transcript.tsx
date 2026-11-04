import { memo, useEffect, useMemo, useState } from "react";
import { Brain, Check, ChevronRight, CircleCheck, CircleX, Copy, Globe, ListTodo, LoaderCircle, MessageCircleQuestion, Pin, PinOff, Sparkles, Square, TerminalSquare, Wrench } from "lucide-react";
import Markdown from "@/components/Markdown";
import { colorize, parseAnsi } from "@/lib/ansi";
import { todoList, type ChatItem, type ToolCall } from "@/lib/messages";
import { usePrefs } from "@/lib/prefs";
import { APP_ANSI_DARK, APP_ANSI_LIGHT, terminalPalette, type TerminalPalette } from "@/lib/terminalThemes";
import { resolvedTheme } from "@/theme";
import { cn, copyText } from "@/lib/utils";
import { t as tr } from "@/i18n/app";

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  const now = new Date();
  const today = now.getFullYear() === d.getFullYear() && now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (today) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date} ${time}`;
}

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

// One tool row: what kind of tool, and the short detail next to it.
function toolLabel(call: ToolCall): { icon: typeof TerminalSquare; title: string; detail: string } {
  switch (call.name) {
    case "remote_exec":
      return { icon: TerminalSquare, title: tr("tool.exec"), detail: call.command };
    case "skill":
      // opencode V2 sends {"id": ...}; "name" is the older shape.
      return { icon: Sparkles, title: tr("tool.skill"), detail: /"(?:id|name)":\s*"([^"]+)"/.exec(call.command)?.[1] ?? "" };
    case "web_search":
      return { icon: Globe, title: tr("tool.search"), detail: /"query":\s*"((?:[^"\\]|\\.)*)"/.exec(call.command)?.[1] ?? "" };
    case "question":
      return { icon: MessageCircleQuestion, title: tr("tool.question"), detail: "" };
    case "todowrite": {
      const list = todoList(call) ?? [];
      const current = list.find((t) => t.status === "in_progress")?.content ?? "";
      return { icon: ListTodo, title: tr("tool.todo", { done: list.filter((t) => t.status === "completed").length, total: list.length }), detail: current };
    }
    default:
      return { icon: Wrench, title: call.name, detail: call.command };
  }
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={tr("common.copy")}
      aria-label={tr("common.copy")}
      onClick={(e) => {
        e.stopPropagation();
        copyText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {}); // Denied or insecure context: stay unchanged, no "copied" flag.
      }}
      className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", className)}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

const TODO_MARK: Record<string, string> = { completed: "✓", in_progress: "◐", cancelled: "✕", pending: "○" };

const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
type AnsiColors = Record<(typeof ANSI_KEYS)[number], string>;

// Output takes the terminal color scheme from Settings; "app" keeps the chat colors with a matching ANSI set.
function useOutputColors(): { palette: TerminalPalette | null; ansi: AnsiColors } {
  const { terminalTheme } = usePrefs();
  const palette = terminalPalette(terminalTheme);
  return { palette, ansi: palette ?? (resolvedTheme() === "dark" ? APP_ANSI_DARK : APP_ANSI_LIGHT) };
}

function Colored({ text, ansi, fg }: { text: string; ansi: AnsiColors; fg?: number }) {
  // With a base color (stderr) only real ANSI codes apply, no word highlight.
  const segments = useMemo(() => (fg === undefined ? colorize(text) : parseAnsi(text)), [text, fg]);
  const css = (c: number | string | undefined) => (typeof c === "number" ? ansi[ANSI_KEYS[c]!] : c);
  return segments.map((s, i) =>
    s.fg === undefined && s.bg === undefined && !s.bold && !s.dim && fg === undefined ? (
      s.text
    ) : (
      <span key={i} style={{ color: css(s.fg ?? fg), background: css(s.bg), fontWeight: s.bold ? 600 : undefined, opacity: s.dim ? 0.7 : undefined }}>
        {s.text}
      </span>
    ),
  );
}

function ToolDetails({ call }: { call: ToolCall }) {
  // Unparsed output of a failed call (e.g. a denied command) is the error itself.
  const errorOnly = call.status === "error" && call.exitCode === null;
  const todos = call.name === "todowrite" ? todoList(call) : null;
  const { palette, ansi } = useOutputColors();
  return (
    <div
      className={cn("mt-1 mb-2 ml-6 overflow-hidden rounded-lg border font-mono text-[length:var(--code-size)] leading-relaxed", !palette && "bg-muted/40")}
      style={palette && !todos ? { background: palette.background, color: palette.foreground } : undefined}
    >
      {todos ? (
        <ul className="space-y-0.5 px-3 py-2 font-sans text-xs">
          {todos.map((t, i) => (
            <li key={i} className={cn("flex gap-2", t.status === "completed" && "text-muted-foreground line-through", t.status === "cancelled" && "text-muted-foreground")}>
              <span className="w-3 shrink-0 text-center">{TODO_MARK[t.status] ?? "○"}</span>
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {call.command && (
            <div className={cn("group/cmd relative border-b", palette ? "bg-black/15" : "bg-background/60")}>
              <pre className="max-h-48 overflow-auto px-3 py-2 pr-9 break-all whitespace-pre-wrap">
                {call.name === "remote_exec" && <span className="select-none" style={{ color: ansi.green }}>$ </span>}
                <span className="font-semibold">{call.command}</span>
              </pre>
              <CopyButton text={call.command} className="absolute top-1 right-1 opacity-0 group-hover/cmd:opacity-100" />
            </div>
          )}
          {call.stdout && !errorOnly && (
            <pre className="max-h-96 overflow-auto px-3 py-2 break-all whitespace-pre-wrap">
              <Colored text={call.stdout} ansi={ansi} />
            </pre>
          )}
          {(call.stderr || errorOnly) && (
            <pre className={cn("max-h-64 overflow-auto bg-destructive/5 px-3 py-2 break-all whitespace-pre-wrap", call.stdout && !errorOnly && "border-t")}>
              <Colored text={errorOnly ? call.output : call.stderr} ansi={ansi} fg={1} />
            </pre>
          )}
          {!call.stdout && !call.stderr && !errorOnly && !running(call) && <p className="px-3 py-1.5 font-sans text-[11px] text-muted-foreground">{tr("tool.noOutput")}</p>}
          {call.notes.map((n) => (
            <p key={n} className="border-t px-3 py-1 font-sans text-[11px] text-muted-foreground">
              {n.replace(/^\[|\]$/g, "")}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

// A tool call as one line; a click opens the full command and its result.
function ToolRow({ call, expand, onStop }: { call: ToolCall; expand: boolean; onStop?: () => void }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isRunning = running(call);
  const bad = failed(call);
  const now = useNow(isRunning);
  const shown = open ?? (call.name === "remote_exec" && (expand || bad));
  const end = call.finished ?? (isRunning ? now : null);
  const took = call.started && end ? end - call.started : null;
  const { icon: Icon, title, detail } = toolLabel(call);
  const toggle = () => setOpen(!shown);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={shown}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}
        className="group/row flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-accent/50"
      >
        <Icon className={cn("size-3.5 shrink-0", isRunning ? "text-primary" : bad ? "text-destructive" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium text-foreground/80">{title}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--code-size)] text-muted-foreground" title={detail}>
          {detail}
        </code>
        {call.raw && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">raw</span>}
        {call.exitCode !== null && call.exitCode !== 0 && <span className="rounded bg-destructive/15 px-1 font-mono text-[10px] text-destructive">exit {call.exitCode}</span>}
        {took !== null && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{duration(took)}</span>}
        {isRunning && onStop && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            title={tr("composer.stopHint")}
            className="flex shrink-0 items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-destructive/90"
          >
            <Square className="size-2.5 fill-current" />
            {tr("composer.stop")}
          </button>
        )}
        {isRunning ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : bad ? (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
        )}
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", shown && "rotate-90")} />
      </div>
      {shown && <ToolDetails call={call} />}
    </div>
  );
}

type Thought = Extract<ChatItem, { kind: "reasoning" }>;

// Model reasoning as one line, collapsed; a click shows the full text.
function ReasoningRow({ item }: { item: Thought }) {
  const [open, setOpen] = useState(false);
  const thinking = item.finished === null;
  const now = useNow(thinking);
  const end = item.finished ?? (thinking ? now : null);
  const took = item.started && end ? end - item.started : null;
  const toggle = () => setOpen(!open);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-accent/50"
      >
        <Brain className={cn("size-3.5 shrink-0", thinking ? "text-primary" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium text-foreground/80">{tr("tool.reasoning")}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground italic">{item.text.trim().split("\n")[0]}</span>
        {took !== null && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{duration(took)}</span>}
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-6 max-h-96 overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {item.text}
        </div>
      )}
    </div>
  );
}

type Shown = Exclude<ChatItem, { kind: "reasoning" | "tool" }>;

// Memoised on content: streaming re-parses the history every frame, and only the growing block should re-render.
// Pin key for an answer block: its stable item id ("msg:text:0") in the characters the server accepts.
export const pinId = (item: { id: string }) => item.id.replaceAll(":", ".");

const Block = memo(function Block({ item, pinned, onPin }: { item: Shown; pinned: boolean; onPin?: (item: Shown, pin: boolean) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div id={`msg-${item.messageId}`} className="group/msg flex scroll-mt-12 flex-col items-end gap-1">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{item.text}</div>
          <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
            <span className="mr-1 tabular-nums">{formatTime(item.time)}</span>
            <CopyButton text={item.text} className="opacity-0 group-hover/msg:opacity-100" />
          </div>
        </div>
      );
    case "text":
      return (
        <div className="group/msg">
          <Markdown text={item.text} className="text-sm" />
          <div className={cn("mt-1 flex items-center gap-0.5 text-[11px] text-muted-foreground transition-opacity group-hover/msg:opacity-100", !pinned && "opacity-0")}>
            <span className="mr-1 tabular-nums">{formatTime(item.time)}</span>
            <CopyButton text={item.text} />
            {onPin && (
              <button
                type="button"
                onClick={() => onPin(item, !pinned)}
                title={tr(pinned ? "msg.unpin" : "msg.pin")}
                aria-label={tr(pinned ? "msg.unpin" : "msg.pin")}
                className={cn("rounded p-1 hover:bg-accent hover:text-foreground", pinned && "text-primary")}
              >
                {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            )}
          </div>
        </div>
      );
    case "error":
      return <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{item.text}</div>;
  }
  // onPin is left out: ChatPage keeps it stable per task.
}, (a, b) => a.item.kind === b.item.kind && a.item.text === b.item.text && a.pinned === b.pinned && !a.onPin === !b.onPin);

type Step = ToolCall | Thought;
type Run = { kind: "tools"; id: string; steps: Step[] } | Shown;
const isThought = (s: Step): s is Thought => "kind" in s;

// The task conversation, in order: answers as markdown, each tool call and reasoning block as one line
// that opens to its full content.
export default function Transcript({
  items,
  working,
  onStop,
  pins,
  onPin,
}: {
  items: ChatItem[];
  live: boolean;
  working: boolean;
  // Shown on the running command; undefined when there is nothing to stop.
  onStop?: () => void;
  // Answers pinned into the model's context, by pinId.
  pins?: Set<string>;
  onPin?: (item: Shown, pin: boolean) => void;
}) {
  const prefs = usePrefs();
  // Consecutive tool calls sit together as one tight list.
  const runs = useMemo(() => {
    const out: Run[] = [];
    for (const item of items) {
      if (item.kind === "reasoning" && !item.text.trim()) continue;
      if (item.kind !== "tool" && item.kind !== "reasoning") {
        out.push(item);
        continue;
      }
      const step = item.kind === "tool" ? item.call : item;
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.steps.push(step);
      else out.push({ kind: "tools", id: item.id, steps: [step] });
    }
    return out;
  }, [items]);
  const userMessages = useMemo(() => items.flatMap((it) => (it.kind === "user" ? [it.messageId] : [])), [items]);
  const [navIndex, setNavIndex] = useState(userMessages.length - 1);

  useEffect(() => {
    setNavIndex(userMessages.length - 1);
  }, [userMessages.length]);

  const scrollTo = (idx: number) => {
    if (idx < 0 || idx >= userMessages.length) return;
    setNavIndex(idx);
    document.getElementById(`msg-${userMessages[idx]}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const last = runs[runs.length - 1];
  const toolRuns = last?.kind === "tools" && last.steps.some((s) => (isThought(s) ? s.finished === null : running(s)));
  return (
    <>
      {userMessages.length > 1 && (
        <div className="sticky top-0 z-10 -mb-2 flex justify-center">
          <div className="flex items-center gap-1 rounded-full border bg-background/90 px-1 py-0.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            <button type="button" onClick={() => scrollTo(navIndex - 1)} disabled={navIndex <= 0} className="rounded-full p-1 hover:bg-accent disabled:opacity-30" title={tr("msg.prevUser")}>
              <ChevronRight className="size-3.5 -rotate-90" />
            </button>
            <span className="tabular-nums">
              {navIndex + 1} / {userMessages.length}
            </span>
            <button type="button" onClick={() => scrollTo(navIndex + 1)} disabled={navIndex >= userMessages.length - 1} className="rounded-full p-1 hover:bg-accent disabled:opacity-30" title={tr("msg.nextUser")}>
              <ChevronRight className="size-3.5 rotate-90" />
            </button>
          </div>
        </div>
      )}
      {runs.map((r) =>
        r.kind === "tools" ? (
          <div key={r.id} className="-mx-1.5 flex flex-col gap-1.5">
            {r.steps.map((s) => (isThought(s) ? <ReasoningRow key={s.id} item={s} /> : <ToolRow key={s.id} call={s} expand={prefs.expandOutput} onStop={onStop} />))}
          </div>
        ) : (
          <Block key={r.id} item={r} pinned={pins?.has(pinId(r)) ?? false} onPin={onPin} />
        ),
      )}
      {working && !toolRuns && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
          <span className="shimmer">{tr("steps.thinking")}</span>
        </div>
      )}
    </>
  );
}
