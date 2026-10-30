import { expect, test } from "bun:test";
import { expandCommand, matchCommands, parseSlash } from "./commands";

test("parseSlash splits the command name from its arguments", () => {
  expect(parseSlash("/disk /var/log")).toEqual({ name: "disk", args: "/var/log" });
  expect(parseSlash("  /init ")).toEqual({ name: "init", args: "" });
  expect(parseSlash("/logs nginx\nза сутки")).toEqual({ name: "logs", args: "nginx\nза сутки" });
  expect(parseSlash("проверь /var")).toBeNull();
  expect(parseSlash("/Var")).toBeNull();
});

test("expandCommand substitutes $ARGUMENTS or appends the arguments", () => {
  expect(expandCommand("Путь: $ARGUMENTS. И снова $ARGUMENTS", "/var")).toBe("Путь: /var. И снова /var");
  expect(expandCommand("Проверь здоровье.\n\n$ARGUMENTS", "")).toBe("Проверь здоровье.");
  expect(expandCommand("Проверь здоровье.", "особенно диски")).toBe("Проверь здоровье.\n\nособенно диски");
});

test("matchCommands puts prefix matches first", () => {
  const list = [
    { name: "logs", description: "Ошибки в журналах" },
    { name: "disk", description: "Место на диске" },
    { name: "service", description: "Сервис" },
  ];
  expect(matchCommands(list, "s").map((c) => c.name)).toEqual(["service", "logs", "disk"]);
  expect(matchCommands(list, "журнал").map((c) => c.name)).toEqual(["logs"]);
});
