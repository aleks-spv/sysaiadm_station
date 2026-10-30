import { expect, test } from "bun:test";
import { groupItems, parseMessages, splitExec, toolCalls, usageOf } from "./messages";

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

test("groupItems joins consecutive reasoning and tools into one run of steps", () => {
  const blocks = groupItems(parseMessages(sample));
  expect(blocks.map((b) => b.kind)).toEqual(["user", "steps", "text", "steps", "error"]);
  expect(blocks[1].kind === "steps" && blocks[1].steps.map((s) => s.kind)).toEqual(["reasoning", "tool"]);
});
