import { expect, test } from "bun:test";
import { latestTodos, mergeTail, parseMessages, splitExec, streamKey, todoList, toolCalls, usageOf, type ToolCall } from "./messages";

const sample: unknown[] = [
  { type: "agent.selected", id: "a0" },
  { type: "user", id: "u1", text: "проверь диск", time: { created: 1 } },
  {
    type: "assistant",
    id: "m1",
    agent: "build",
    model: { providerID: "opencode", id: "big" },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
    cost: 0.01,
    content: [
      { type: "reasoning", text: "думаю" },
      { type: "tool", id: "t1", name: "remote_exec", state: { status: "completed", input: { command: "df -h" }, content: [{ type: "text", text: "/dev/sda1 10G" }] } },
      { type: "text", text: "Места хватает" },
    ],
  },
  {
    type: "assistant",
    id: "m2",
    tokens: { input: 300, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "tool", id: "t2", name: "remote_exec", state: { status: "error", input: { command: "rm -rf /" }, error: { message: "denied" } } }],
    error: { message: "boom" },
  },
  null,
  "garbage",
];

test("parseMessages keeps user, text, reasoning, tools and errors in order", () => {
  const items = parseMessages(sample);
  expect(items.map((i) => i.kind)).toEqual(["user", "reasoning", "tool", "text", "tool", "error"]);
  const calls = toolCalls(items);
  expect(calls[0]).toMatchObject({ name: "remote_exec", status: "completed", command: "df -h", output: "/dev/sda1 10G" });
  expect(calls[1]).toMatchObject({ status: "error", command: "rm -rf /", output: "denied" });
});

test("parseMessages fills empty parts from streamed deltas and appends parts the list does not have yet", () => {
  const list = [
    { type: "user", id: "u1", text: "hi", time: { created: 1 } },
    { type: "assistant", id: "m1", content: [{ type: "reasoning", text: "" }, { type: "text", text: "" }] },
  ];
  const streamed = { [streamKey("m1", "reasoning", 0)]: "think", [streamKey("m1", "text", 0)]: "hel", [streamKey("m2", "text", 0)]: "next" };
  const items = parseMessages(list, streamed);
  expect(items.map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([["user", "hi"], ["reasoning", "think"], ["text", "hel"], ["text", "next"]]);
  // Stored text wins over the stream and keeps the same id.
  const done = parseMessages([list[0], { type: "assistant", id: "m1", content: [{ type: "text", text: "hello" }] }], { [streamKey("m1", "text", 0)]: "hel" });
  expect(done[1]).toMatchObject({ id: streamKey("m1", "text", 0), text: "hello" });
});

test("usageOf sums tokens and keeps the last step as context size", () => {
  const usage = usageOf(sample);
  expect(usage).toMatchObject({ input: 400, output: 30, reasoning: 5, cacheRead: 50, lastContext: 300, agent: "build" });
  expect(usage.model).toEqual({ providerID: "opencode", id: "big" });
  expect(usage.cost).toBeCloseTo(0.01);
});

test("splitExec separates exit code, streams and trailing notes", () => {
  const out = ["exit=1", "--- stdout ---", "a", "b", "--- stderr ---", "oops", "[output truncated]", "[вывод сжат на 40% (compact); полный вывод — тот же remote_exec с raw=true]"].join("\n");
  expect(splitExec(out)).toEqual({ exitCode: 1, stdout: "a\nb", stderr: "oops", notes: ["[output truncated]", "[вывод сжат на 40% (compact); полный вывод — тот же remote_exec с raw=true]"] });
  expect(splitExec(["exit=0", "--- stdout ---", "ok", "--- stderr ---", "", "", ""].join("\n"))).toEqual({ exitCode: 0, stdout: "ok", stderr: "", notes: [] });
  expect(splitExec("plain text")).toBeNull();
});

test("latestTodos reads the plan from the last completed todowrite call", () => {
  const call = (status: ToolCall["status"], todos: unknown) => ({ ...toolCalls(parseMessages(sample))[0], name: "todowrite", status, command: JSON.stringify({ todos }) });
  const done = call("completed", [{ content: "backup", status: "completed" }, { content: "upgrade", status: "in_progress" }, { content: "", status: "pending" }]);
  expect(latestTodos([done, call("streaming", [])])).toEqual([{ content: "backup", status: "completed" }, { content: "upgrade", status: "in_progress" }]);
  expect(todoList({ ...done, command: '{"todos":[' })).toBeNull();
  expect(latestTodos([])).toBeNull();
});

test("mergeTail lays the fresh tail over the loaded history", () => {
  const a = { id: "a" }, b = { id: "b", v: 1 }, c = { id: "c" };
  const prev = [a, b];
  expect(mergeTail(prev, [{ id: "b", v: 1 }])).toBe(prev);
  const next = mergeTail(prev, [{ id: "b", v: 2 }, c])!;
  expect(next).toEqual([a, { id: "b", v: 2 }, c]);
  expect(next[0]).toBe(a);
  expect(mergeTail(prev, [{ id: "x" }])).toBeNull();
  expect(mergeTail(prev, [])).toBeNull();
});
