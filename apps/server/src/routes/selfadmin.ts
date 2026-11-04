import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { commandInFlight } from "../exec-registry";
import { audit } from "../guard";
import type { OpenCodeClient } from "../opencode";
import { getOverlay, saveOverlay, validateOverlay, type Overlay } from "../opencode-config";
import type { OpencodeInstaller } from "../opencode-install";
import type { OpencodeProc } from "../opencode-proc";

// `sysadm-oc` inside the container (docker/sysadm-oc): the agent on the localhost node manages the station's opencode.
// Reads are free; every change must come from a remote command the admin approved and that is still running.
// Secrets never come out: provider keys stay in opencode, key-like fields of the overlay are redacted.

export interface SelfAdminDeps {
  db: Database;
  token: string;
  client: OpenCodeClient;
  apply(overlay: Overlay): void;
  proc: Pick<OpencodeProc, "status" | "restart">;
  installer?: OpencodeInstaller;
}

const ACTOR = "sysadm-oc";
export const REDACTED = "<redacted>";
const SECRET_FIELD = /key|token|secret|password|authorization|cookie/i;
// A registry package with an optional version or tag: no URLs, git refs, tarballs or local paths.
const NPM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.^~<>=*-]+)?$/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) && typeof v === "string" ? REDACTED : redact(v)]));
}

// The agent edits a redacted copy; placeholders it sends back keep the stored secret.
export function restore(next: unknown, prev: unknown): unknown {
  if (next === REDACTED) return prev;
  if (Array.isArray(next)) return next.map((v, i) => restore(v, Array.isArray(prev) ? prev[i] : undefined));
  if (!isObject(next)) return next;
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restore(v, isObject(prev) ? prev[k] : undefined)]));
}

const digest = (v: string) => createHash("sha256").update(v).digest();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const approved = (call: string) => commandInFlight(new RegExp(`\\bsysadm-oc\\s+${call}(\\s|$|['";&|)])`, "i"));
const NOT_APPROVED = { error: "команда должна идти через remote_exec с подтверждением администратора" };

export function selfAdminRoutes(deps: SelfAdminDeps): Hono {
  const { db, client, proc, installer } = deps;
  const app = new Hono();

  app.use("/selfadmin/*", async (c, next) => {
    const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!timingSafeEqual(digest(given), digest(deps.token))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/selfadmin/models", async (c) => {
    const { data } = (await client.model.list()) as { data: Array<{ id: string; providerID: string; name: string }> };
    return c.json(data.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name })));
  });

  app.get("/selfadmin/providers", async (c) => {
    const { data } = (await client.integration.list()) as { data: Array<{ id: string; name: string; connections: unknown[] }> };
    return c.json(data.map((p) => ({ id: p.id, name: p.name, connected: p.connections.length > 0 })));
  });

  app.get("/selfadmin/plugins", async (c) => c.json(await client.plugin.list()));

  app.get("/selfadmin/config", (c) => c.json(redact(getOverlay(db))));

  app.get("/selfadmin/version", async (c) => {
    if (!installer) return c.json({ error: "opencode installer is not configured" }, 404);
    return c.json(await installer.info(true));
  });

  app.put("/selfadmin/config", async (c) => {
    if (!approved("set-config")) return c.json(NOT_APPROVED, 403);
    const body = await c.req.json().catch(() => null);
    const overlay = restore(body, getOverlay(db));
    const errors = validateOverlay(overlay);
    if (errors.length > 0) return c.json({ error: errors.join("; ") }, 400);
    saveOverlay(db, overlay as Overlay);
    deps.apply(overlay as Overlay);
    audit(db, { actor: ACTOR, action: "opencode_config", detail: { keys: Object.keys(overlay as Overlay) } });
    return c.json({ ok: true });
  });

  app.post("/selfadmin/plugins", async (c) => {
    const body = await c.req.json().catch(() => null);
    const spec = body?.package;
    if (typeof spec !== "string" || spec.length > 214 || !NPM_SPEC.test(spec)) return c.json({ error: "нужно имя npm-пакета, например opencode-foo или @scope/pkg@1.2.3" }, 400);
    if (!approved(`plugin-add\\s+['"]?${escape(spec)}`)) return c.json(NOT_APPROVED, 403);
    const overlay = getOverlay(db);
    const plugins = Array.isArray(overlay.plugins) ? overlay.plugins : [];
    if (!plugins.includes(spec)) {
      const next = { ...overlay, plugins: [...plugins, spec] };
      saveOverlay(db, next);
      deps.apply(next);
    }
    audit(db, { actor: ACTOR, action: "opencode_plugin_add", detail: { package: spec } });
    return c.json({ ok: true });
  });

  app.post("/selfadmin/restart", async (c) => {
    if (!approved("restart")) return c.json(NOT_APPROVED, 403);
    audit(db, { actor: ACTOR, action: "opencode_restart" });
    // After the reply: the restart kills the agent's own session mid-call.
    setTimeout(() => void proc.restart(), 500);
    return c.json({ ok: true });
  });

  app.post("/selfadmin/upgrade", async (c) => {
    if (!approved("upgrade")) return c.json(NOT_APPROVED, 403);
    if (!installer) return c.json({ error: "opencode installer is not configured" }, 404);
    const before = await installer.info(true);
    if (before.busy) return c.json({ error: "установка opencode уже идёт" }, 409);
    if (before.mode === "external") return c.json({ error: "opencode задан через OPENCODE_BIN" }, 409);
    if (!before.updateAvailable) return c.json({ ok: true, current: before.current, message: "уже последняя версия" });
    void installer.upgrade(proc).then(
      (after) => audit(db, { actor: ACTOR, action: "opencode_upgrade", detail: { from: before.current, to: after.current } }),
      (e: unknown) => audit(db, { actor: ACTOR, action: "opencode_upgrade", detail: { from: before.current, error: e instanceof Error ? e.message : String(e) } }),
    );
    return c.json({ ok: true, from: before.current, to: before.latest, message: "обновление запущено; opencode перезапустится, текущая задача прервётся" });
  });

  return app;
}
