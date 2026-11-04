import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardPaste, Copy, RotateCw, Unplug } from "lucide-react";
import type { InventoryNode } from "@sysadm/shared";
import { Button } from "@/components/ui/button";
import { fontStack, getPrefs, usePrefs } from "@/lib/prefs";
import { APP_ANSI_DARK, APP_ANSI_LIGHT, terminalPalette } from "@/lib/terminalThemes";
import { resolvedTheme } from "@/theme";
import { serverMsg } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { terminalUrl, type ClientMessage, type ServerMessage } from "./protocol";
import { t } from "./i18n";


interface Link {
  phase: "idle" | "connecting" | "connected" | "closed";
  text: string;
  error?: boolean;
}

const IDLE: Link = { phase: "idle", text: t("status.idle") };

// Debian/Proxmox root ships a .bashrc without colors. For this session only: a colored bash prompt
// unless the server already has one, and ls/grep colors unless already aliased. Leading space keeps
// it out of history where HISTCONTROL allows; the screen is cleared afterwards, scrollback stays.
const COLORIZE =
  " case \"$BASH_VERSION:$PS1\" in :*|*'\\033['*|*'\\e['*) ;; *) PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ ';; esac;" +
  " alias ls >/dev/null 2>&1 || alias ls='ls --color=auto'; alias grep >/dev/null 2>&1 || alias grep='grep --color=auto';" +
  " printf '\\033[H\\033[2J'\r";

// xterm needs rgb/hex, but theme variables are oklch(); a 1x1 canvas converts any CSS color.
function cssColor(varName: string, fallback: string): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  ctx.fillStyle = fallback; // an unparsable value leaves this color in place
  ctx.fillStyle = value || fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

// Settings → General → terminal colors; "app" takes the UI colors and a matching ANSI set.
function theme(id: string): ITheme {
  const palette = terminalPalette(id);
  if (palette) return palette;
  return {
    ...(resolvedTheme() === "dark" ? APP_ANSI_DARK : APP_ANSI_LIGHT),
    background: cssColor("--background", "#ffffff"),
    foreground: cssColor("--foreground", "#000000"),
    cursor: cssColor("--primary", "#000000"),
    selectionBackground: cssColor("--accent", "#cccccc"),
  };
}

export default function TerminalPanel({ node, active }: { node: InventoryNode; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const started = useRef(false);
  const [link, setLink] = useState<Link>(IDLE);

  const send = useCallback((msg: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Sends the size only when it differs from the last one the server knows about.
  const sendSize = useCallback(() => {
    const term = termRef.current;
    if (!term || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const last = sizeRef.current;
    if (last?.cols === term.cols && last?.rows === term.rows) return;
    sizeRef.current = { cols: term.cols, rows: term.rows };
    send({ type: "resize", cols: term.cols, rows: term.rows });
  }, [send]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
    fitRef.current?.fit();
    sendSize();
  }, [sendSize]);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    socketRef.current?.close();
    term.reset();
    const { cols, rows } = term;
    sizeRef.current = { cols, rows };
    const ws = new WebSocket(terminalUrl(node.id, cols, rows));
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;
    setLink({ phase: "connecting", text: t("status.connecting") });
    ws.onopen = () => sendSize();
    // Input sent before the shell reads the terminal can be lost (login scripts, PAM, a tty flush), so
    // COLORIZE goes out once the output has gone quiet after the first prompt, or after 3 s at most.
    let colorize = false;
    let colorizeTimer = 0;
    const colorizeAfter = (ms: number) => {
      window.clearTimeout(colorizeTimer);
      colorizeTimer = window.setTimeout(() => {
        if (!colorize || socketRef.current !== ws) return;
        colorize = false;
        send({ type: "input", data: COLORIZE });
      }, ms);
    };
    ws.onmessage = (ev) => {
      // Stale sockets (replaced or closed by the user) must not touch the terminal or the status.
      if (socketRef.current !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        if (colorize) colorizeAfter(300);
        return;
      }
      const msg = JSON.parse(ev.data) as ServerMessage;
      switch (msg.type) {
        case "ready":
          colorize = node.os !== "windows" && getPrefs().terminalColorize;
          if (colorize) colorizeAfter(3000);
          setLink({
            phase: "connected",
            text: `${t("status.connected", { node: msg.node })}${msg.via.length ? ` ${t("status.via", { via: msg.via.join(" → ") })}` : ""}`,
          });
          break;
        case "error":
          term.write(`\r\n\x1b[31m${serverMsg(msg.message)}\x1b[0m\r\n`);
          setLink({ phase: "closed", text: serverMsg(msg.message), error: true });
          break;
        case "exit":
          setLink({ phase: "closed", text: t("status.exited", { code: msg.code ?? "—" }) });
          break;
      }
    };
    ws.onclose = () => {
      window.clearTimeout(colorizeTimer);
      if (socketRef.current !== ws) return;
      socketRef.current = null;
      setLink((prev) => (prev.phase === "closed" ? prev : { phase: "closed", text: t("status.closed") }));
    };
  }, [node.id, node.os, send, sendSize]);

  const disconnect = useCallback(() => {
    const ws = socketRef.current;
    socketRef.current = null;
    ws?.close();
    setLink({ phase: "closed", text: t("status.disconnected") });
  }, []);

  // Terminal lives per node; the session is only closed here, never on tab switches.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: getPrefs().terminalSize,
      lineHeight: getPrefs().terminalLineHeight,
      fontFamily: fontStack(getPrefs().terminalFont),
      scrollback: 5000,
      convertEol: false,
      theme: theme(getPrefs().terminalTheme),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl+Shift+C / Cmd+C, or Ctrl+C over a selection, copies; plain Ctrl+C still sends ^C.
      if (mod && key === "c" && (e.shiftKey || e.metaKey || term.hasSelection())) {
        e.preventDefault();
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      // Ctrl/Cmd+V and Ctrl+Shift+V: left to the browser, xterm receives the paste event.
      if (mod && key === "v") return false;
      return true;
    });
    const onData = term.onData((data) => send({ type: "input", data }));
    termRef.current = term;
    fitRef.current = fitAddon;
    sizeRef.current = null;
    setLink(IDLE);
    return () => {
      onData.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      started.current = false;
    };
  }, [node.id, send]);

  // Settings → General: font and color changes apply to the open session.
  const { terminalFont, terminalSize, terminalLineHeight, terminalTheme } = usePrefs();
  useEffect(() => {
    const apply = () => {
      if (termRef.current) termRef.current.options.theme = theme(terminalTheme);
    };
    apply();
    if (terminalTheme !== "app") return;
    // The "app" scheme follows light/dark switches, which toggle classes on <html>.
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [terminalTheme]);
  useEffect(() => {
    const stack = fontStack(terminalFont);
    let cancelled = false;
    // xterm measures the cell once: wait for the web font, or the grid is sized by the fallback font.
    document.fonts
      .load(`${terminalSize}px ${stack}`)
      .catch(() => [])
      .then(() => {
        const term = termRef.current;
        if (cancelled || !term) return;
        term.options.fontFamily = stack;
        term.options.fontSize = terminalSize;
        term.options.lineHeight = terminalLineHeight;
        fit();
      });
    return () => {
      cancelled = true;
    };
  }, [terminalFont, terminalSize, terminalLineHeight, fit]);

  // Connects on the first activation for this node; later tab switches keep the session.
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    connect();
  }, [active, node.id, connect]);

  useEffect(() => {
    if (!active) return;
    fit();
    termRef.current?.focus();
  }, [active, fit]);

  useEffect(() => {
    const el = containerRef.current;
    if (!active || !el) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, 100);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [active, fit]);

  const copy = () => {
    const term = termRef.current;
    const text = term?.getSelection();
    if (text) void navigator.clipboard?.writeText(text).catch(() => window.alert(t("clipboardDenied")));
    term?.focus();
  };
  const paste = async () => {
    const term = termRef.current;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term?.paste(text);
    } catch {
      window.alert(t("clipboardDenied"));
    }
    term?.focus();
  };

  const live = link.phase === "connecting" || link.phase === "connected";
  const dot =
    link.phase === "connected"
      ? "bg-emerald-500"
      : link.phase === "connecting"
        ? "animate-pulse bg-amber-500"
        : link.error
          ? "bg-destructive"
          : "bg-muted-foreground";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <span className={cn("size-2 shrink-0 rounded-full", dot)} />
        <span
          className={cn("min-w-0 flex-1 truncate", link.error ? "text-destructive" : "text-muted-foreground")}
          title={link.text}
        >
          {link.text}
        </span>
        <Button variant="ghost" size="icon-sm" title={t("copy")} aria-label={t("copy")} onClick={copy}>
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("paste")} aria-label={t("paste")} disabled={!live} onClick={paste}>
          <ClipboardPaste />
        </Button>
        <Button variant="ghost" size="icon-sm" title={t("reconnect")} aria-label={t("reconnect")} onClick={connect}>
          <RotateCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("disconnect")}
          aria-label={t("disconnect")}
          disabled={!live}
          onClick={disconnect}
        >
          <Unplug />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={containerRef} className="min-h-0 flex-1 bg-background p-1" />
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Button variant="outline" size="sm" onClick={connect}>
              {t("connect")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
