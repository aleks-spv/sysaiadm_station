import { expect, test } from "bun:test";
import { format } from "./index";

test("format fills placeholders and leaves unknown ones", () => {
  expect(format("Задача для агента на {name}…", { name: "web1" })).toBe("Задача для агента на web1…");
  expect(format("{a} и {b}", { a: 1 })).toBe("1 и {b}");
});

test("format picks the plural form by count", () => {
  // Tests run without a browser, so the language is English.
  const msg = { one: "{count} command", other: "{count} commands" };
  expect(format(msg, { count: 1 })).toBe("1 command");
  expect(format(msg, { count: 5 })).toBe("5 commands");
});
