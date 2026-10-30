import { expect, test } from "bun:test";
import { DEFAULT_COMMANDS, validateCommands } from "./commands";

test("default commands pass their own validation", () => {
  expect(validateCommands(DEFAULT_COMMANDS)).toEqual(DEFAULT_COMMANDS);
});

test("validateCommands rejects reserved, duplicate and malformed commands", () => {
  const ok = { name: "/Disk2", description: "", template: "x", agent: "" };
  expect(validateCommands([ok])).toBe("имя «Disk2»: латиница в нижнем регистре, цифры, - и _, до 32 символов");
  expect(validateCommands([{ ...ok, name: "/disk2" }])).toEqual([{ name: "disk2", description: "", template: "x", agent: null }]);
  expect(validateCommands([{ ...ok, name: "init" }])).toBe("/init — встроенная команда");
  expect(validateCommands([{ ...ok, name: "a" }, { ...ok, name: "a" }])).toBe("команда /a повторяется");
  expect(validateCommands([{ ...ok, name: "a", template: "  " }])).toContain("пустой");
  expect(validateCommands([{ ...ok, name: "a", agent: "bad agent" }])).toContain("агента");
  expect(validateCommands("nope")).toBe("commands должен быть списком");
});
