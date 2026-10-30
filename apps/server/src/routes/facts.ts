import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { collectFacts } from "../facts";
import { materializeNode } from "../materialize";
import type { ExecInput, ExecOutput } from "../ssh";
import type { Bus } from "./events";

interface FactsDeps {
  db: Database;
  masterKey: Buffer;
  infraDir: string;
  bus?: Bus;
  exec?: (input: ExecInput) => Promise<ExecOutput>;
}

// /init: collect the server card over SSH, store it and put it into the node's AGENTS.md.
export function factsRoutes(deps: FactsDeps): Hono {
  const app = new Hono();
  app.post("/api/nodes/:id/facts", async (c) => {
    const id = c.req.param("id");
    try {
      const facts = await collectFacts(deps.db, deps.masterKey, id, c.get("actor"), deps.exec);
      await materializeNode(deps.db, deps.infraDir, id);
      deps.bus?.publish({ type: "tree.updated", nodeId: id });
      return c.json(facts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message === "узел не найден" ? 404 : 502);
    }
  });
  return app;
}
