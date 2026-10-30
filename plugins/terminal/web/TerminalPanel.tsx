import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCw, Unplug } from "lucide-react";
import type { InventoryNode } from "@sysadm/shared";
import { Button } from "@/components/ui/button";
import { fontStack, getPrefs, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { terminalUrl, type ClientMessage, type ServerMessage } from "./protocol";
import { t } from "./i18n";


interface Link {
  phase: "idle" | "connecting" | "connected" | "closed";
  text: string;
  error?: boolean;
}

const IDLE: Link = { phase: "idle", text: t("status.idle") };

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

function theme(): ITheme {
  return {
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
    ws.onmessage = (ev) => {
      // Stale sockets (replaced or closed by the user) must not touch the terminal or the status.
      if (socketRef.current !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
      const msg = JSON.parse(ev.data) as ServerMessage;
      switch (msg.type) {
        case "ready":
          setLink({
            phase: "connected",
            text: `${t("status.connected", { node: msg.node })}${msg.via.length ? ` ${t("status.via", { via: msg.via.join(" → ") })}` : ""}`,
          });
          break;
        case "error":
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          setLink({ phase: "closed", text: msg.message, error: true });
          break;
        case "exit":
          setLink({ phase: "closed", text: t("status.exited", { code: msg.code ?? "—" }) });
          break;
      }
    };
    ws.onclose = () => {
      if (socketRef.current !== ws) return;
      socketRef.current = null;
      setLink((prev) => (prev.phase === "closed" ? prev : { phase: "closed", text: t("status.closed") }));
    };
  }, [node.id, sendSize]);

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
      fontFamily: fontStack(getPrefs().terminalFont),
      scrollback: 5000,
      convertEol: false,
      theme: theme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
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

  // Settings → General: font changes apply to the open session.
  const { terminalFont, terminalSize } = usePrefs();
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontStack(terminalFont);
    term.options.fontSize = terminalSize;
    fit();
  }, [terminalFont, terminalSize, fit]);

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
