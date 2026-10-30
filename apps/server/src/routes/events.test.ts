import { expect, test } from "bun:test";
import { openDb } from "../db";
import type { OpenCodeClient } from "../opencode";
import { createQuestionGuard } from "../question-guard";
import { createBus, startEventBridge } from "./events";

test("an agent question puts the task into waiting and the answer resumes it", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'vm', 'vm1')");
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('t1', 'n1', 'ses_1', 't', 'running', 0)");
  const statuses: string[] = [];
  const bus = createBus();
  bus.subscribe((data) => statuses.push((JSON.parse(data) as { status: string }).status));
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const client = {
    event: {
      subscribe: async function* () {
        yield { type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_1", title: "?", fields: [] } } };
        yield { type: "form.replied", data: { id: "frm_1", sessionID: "ses_1" } };
        release();
        await new Promise(() => {});
      },
    },
  } as unknown as OpenCodeClient;
  const stop = startEventBridge({ db, client, bus });
  await done;
  stop();
  expect(statuses).toEqual(["waiting_permission", "running"]);
});

test("streamed text deltas reach the browser bus with the task id", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'vm', 'vm1')");
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('t1', 'n1', 'ses_1', 't', 'running', 0)");
  const sent: unknown[] = [];
  const bus = createBus();
  bus.subscribe((data) => sent.push(JSON.parse(data)));
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const client = {
    event: {
      subscribe: async function* () {
        yield { type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "w0 " } };
        yield { type: "session.reasoning.delta", data: { sessionID: "ses_other", assistantMessageID: "msg_2", ordinal: 0, delta: "x" } };
        release();
        await new Promise(() => {});
      },
    },
  } as unknown as OpenCodeClient;
  const stop = startEventBridge({ db, client, bus });
  await done;
  stop();
  expect(sent).toEqual([{ type: "task.delta", taskId: "t1", messageId: "msg_1", ordinal: 0, part: "text", delta: "w0 " }]);
});

test("a repeated question is cancelled for the model without bothering the admin", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'vm', 'vm1')");
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('t1', 'n1', 'ses_1', 't', 'running', 0)");
  const guard = createQuestionGuard();
  guard.created({ id: "frm_1", sessionID: "ses_1", title: "Какая задача?", fields: [] });
  guard.answered("ses_1", "frm_1", {});
  const statuses: string[] = [];
  const bus = createBus();
  bus.subscribe((data) => statuses.push((JSON.parse(data) as { status: string }).status));
  const cancelled: Array<{ formID: string; message: string }> = [];
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const client = {
    session: { form: { cancel: async (input: { formID: string; message: string }) => void cancelled.push(input) } },
    event: {
      subscribe: async function* () {
        yield { type: "form.created", data: { form: { id: "frm_2", sessionID: "ses_1", title: "Какая задача?", fields: [] } } };
        release();
        await new Promise(() => {});
      },
    },
  } as unknown as OpenCodeClient;
  const stop = startEventBridge({ db, client, bus, guard });
  await done;
  stop();
  expect(cancelled.map((c) => c.formID)).toEqual(["frm_2"]);
  expect(cancelled[0]!.message).toContain("уже задавал");
  expect(statuses).toEqual([]);
  expect(db.query("SELECT action FROM audit").all()).toEqual([{ action: "question_auto" }]);
});
