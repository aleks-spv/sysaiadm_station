import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { audit } from "../guard";
import type { OpenCodeClient } from "../opencode";
import { getOverlay, LOCKED_KEYS, saveOverlay, validateOverlay, type Overlay } from "../opencode-config";
import { getSetting, setSetting } from "../settings";

export interface OpencodeSettingsDeps {
  db: Database;
  client: OpenCodeClient;
  // Writes opencode.json from the overlay; opencode reloads it on its own.
  apply(overlay: Overlay): void;
}

const MODEL_REF = /^[^\s/]{1,128}\/\S{1,256}$/;
const MAX_HIDDEN = 5000;

export function opencodeSettingsRoutes(deps: OpencodeSettingsDeps): Hono {
  const { db, client } = deps;
  const app = new Hono();

  app.get("/api/settings/opencode-config", (c) => c.json({ overlay: getOverlay(db), locked: LOCKED_KEYS }));

  app.put("/api/settings/opencode-config", async (c) => {
    const body = await c.req.json().catch(() => null);
    const errors = validateOverlay(body?.overlay);
    if (errors.length > 0) return c.json({ error: errors.join("; "), errors }, 400);
    const overlay = body.overlay as Overlay;
    saveOverlay(db, overlay);
    deps.apply(overlay);
    audit(db, { actor: c.get("actor"), action: "opencode_config", detail: { keys: Object.keys(overlay) } });
    return c.json({ overlay });
  });

  app.get("/api/settings/opencode-plugins", async (c) => c.json(await client.plugin.list()));

  app.get("/api/settings/hidden-models", (c) => c.json(getSetting<string[]>(db, "hidden_models") ?? []));

  // Hidden models stay usable in opencode; only sysadm pickers skip them.
  app.put("/api/settings/hidden-models", async (c) => {
    const body = await c.req.json().catch(() => null);
    const list: unknown = body?.models;
    if (!Array.isArray(list) || list.length > MAX_HIDDEN || !list.every((m) => typeof m === "string" && MODEL_REF.test(m))) {
      return c.json({ error: "models должен быть списком provider/model" }, 400);
    }
    const models = [...new Set(list as string[])];
    setSetting(db, "hidden_models", models);
    return c.json(models);
  });

  return app;
}
