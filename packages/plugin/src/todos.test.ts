import { expect, test } from "bun:test";
import { applyWrite, isOpen, renderForModel, validate } from "./todos";

test("items keep ids by echoed id or by content", () => {
  const first = applyWrite([], validate({ todos: [{ content: "backup", status: "in_progress" }, { content: "upgrade", status: "pending" }] }), 1);
  const [a, b] = first;
  const second = applyWrite(first, [{ id: a.id, content: "backup config", status: "completed" }, { content: "upgrade", status: "in_progress" }], 2);
  expect(second.map((t) => t.id)).toEqual([a.id, b.id]);
  expect(renderForModel(second)).toContain("[x] backup config");
  expect(isOpen(second)).toBe(true);
  expect(isOpen(second.map((t) => ({ ...t, status: "completed" as const })))).toBe(false);
});

test("bad input is rejected with a message for the model", () => {
  expect(() => validate({ todos: [{ content: " ", status: "pending" }] })).toThrow("empty content");
  expect(() => validate({ todos: [{ content: "x", status: "done" }] })).toThrow("bad status");
  expect(() => validate({})).toThrow("array");
});
