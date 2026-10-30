import { Hono } from "hono";
import type { PluginContext, ServerPlugin } from "../../../apps/server/src/plugins/types";

const MAX_SESSIONS = 8;
const MAX_INPUT = 64 * 1024;

const size = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 10 && n <= 1000 ? n : fallback;
};

interface Shell {
  stream: { write(data: string): unknown };
  resize(cols: number, rows: number): void;
}

// Client → server frames: {type:"input",data} | {type:"resize",cols,rows}; anything else is ignored.
export function handleClientMessage(raw: unknown, shell: Shell): void {
  if (typeof raw !== "string" || raw.length > MAX_INPUT) return;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as Record<string, unknown>;
  if (m.type === "input" && typeof m.data === "string") shell.stream.write(m.data);
  else if (m.type === "resize") shell.resize(size(m.cols, 80), size(m.rows, 24));
}

// The session cookie is SameSite=Strict, so a cross-site page cannot open the socket; the Origin check is the second lock.
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createTerminalPlugin(): ServerPlugin {
  let active = 0;

  return {
    id: "terminal",
    name: "Терминал",
    description: "Интерактивный SSH-терминал на сервер в правой панели: тот же маршрут через бастионы и те же креды, что у агента. Только для администратора, без фильтра команд.",

    routes(ctx: PluginContext) {
      const app = new Hono();
      app.use("/ws/*", async (c, next) => {
        if (!sameOrigin(c.req.header("origin"), c.req.header("host"))) return c.json({ error: "bad origin" }, 403);
        await next();
      });
      app.get(
        "/ws/:nodeId",
        ctx.upgradeWebSocket((c) => {
          const nodeId = c.req.param("nodeId") ?? "";
          const actor: string = c.get("actor") ?? "admin";
          const cols = size(c.req.query("cols"), 80);
          const rows = size(c.req.query("rows"), 24);
          let shell: Awaited<ReturnType<PluginContext["ssh"]["openShell"]>> | null = null;
          let closed = false;
          let counted = false;
          let opened = 0;

          return {
            onOpen(_evt, ws) {
              const fail = (message: string) => {
                ws.send(JSON.stringify({ type: "error", message }));
                ws.close(1011, "error");
              };
              if (active >= MAX_SESSIONS) return fail(`открыто слишком много терминалов (максимум ${MAX_SESSIONS})`);
              active++;
              counted = true;
              ctx.ssh
                .openShell(nodeId, cols, rows)
                .then((opened_) => {
                  if (closed) return opened_.session.close();
                  shell = opened_;
                  opened = Date.now();
                  ctx.audit(actor, "terminal_open", { via: opened_.via }, { nodeId });
                  ws.send(JSON.stringify({ type: "ready", node: opened_.node, via: opened_.via }));
                  const { stream } = opened_.session;
                  stream.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
                  stream.stderr.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
                  let code: number | null = null;
                  stream.on("exit", (c: number | null) => (code = c));
                  stream.on("close", () => {
                    if (closed) return;
                    ws.send(JSON.stringify({ type: "exit", code }));
                    ws.close(1000, "exit");
                  });
                })
                .catch((err: unknown) => {
                  ctx.log("warn", `terminal ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
                  fail(err instanceof Error ? err.message : "не удалось открыть терминал");
                });
            },
            onMessage(evt) {
              if (shell) handleClientMessage(evt.data, shell.session);
            },
            onClose() {
              closed = true;
              if (counted) active--;
              counted = false;
              if (shell) {
                shell.session.close();
                ctx.audit(actor, "terminal_close", { durationMs: Date.now() - opened }, { nodeId });
                shell = null;
              }
            },
          };
        }),
      );
      return app;
    },
  };
}

export const terminalPlugin = createTerminalPlugin();
