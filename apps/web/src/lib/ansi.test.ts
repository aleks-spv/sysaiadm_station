import { expect, test } from "bun:test";
import { colorize, highlight, parseAnsi } from "./ansi";

test("parseAnsi applies SGR colors and drops other escapes", () => {
  expect(parseAnsi("\x1b[1;32mok\x1b[0m done\x1b[2K")).toEqual([
    { text: "ok", bold: true, fg: 2 },
    { text: " done" },
  ]);
  expect(parseAnsi("\x1b[94mA\x1b[38;5;196mB\x1b[38;2;1;2;3mC\x1b[39mD")).toEqual([
    { text: "A", fg: 12 },
    { text: "B", fg: "rgb(255,0,0)" },
    { text: "C", fg: "rgb(1,2,3)" },
    { text: "D" },
  ]);
});

test("highlight colors errors, ok words, IPs, paths and sizes", () => {
  const colored = highlight("nginx.service failed on 10.0.0.1:80, /var/log 95% ok").filter((s) => s.fg !== undefined);
  expect(colored.map((s) => [s.text, s.fg])).toEqual([
    ["failed", 1],
    ["10.0.0.1:80", 5],
    ["/var/log", 4],
    ["95%", 6],
    ["ok", 2],
  ]);
  expect(highlight("plain words").map((s) => s.text).join("")).toBe("plain words");
});

test("colorize prefers real ANSI codes over the highlight", () => {
  expect(colorize("\x1b[31merror\x1b[0m 5")).toEqual([{ text: "error", fg: 1 }, { text: " 5" }]);
});
