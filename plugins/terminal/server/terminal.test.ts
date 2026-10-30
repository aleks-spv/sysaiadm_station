import { expect, test } from "bun:test";
import { handleClientMessage, sameOrigin } from "./index";

test("sameOrigin", () => {
  expect(sameOrigin("https://sysadm.example", "sysadm.example")).toBe(true);
  expect(sameOrigin("https://evil.example", "sysadm.example")).toBe(false);
  expect(sameOrigin(undefined, "sysadm.example")).toBe(false);
  expect(sameOrigin("garbage", "sysadm.example")).toBe(false);
});

test("handleClientMessage writes input, resizes within bounds, ignores junk", () => {
  const written: string[] = [];
  const sizes: Array<[number, number]> = [];
  const shell = { stream: { write: (d: string) => written.push(d) }, resize: (c: number, r: number) => sizes.push([c, r]) };
  handleClientMessage(JSON.stringify({ type: "input", data: "ls\r" }), shell);
  handleClientMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }), shell);
  handleClientMessage(JSON.stringify({ type: "resize", cols: 99999, rows: -1 }), shell);
  handleClientMessage("not json", shell);
  handleClientMessage(JSON.stringify({ type: "input", data: 42 }), shell);
  expect(written).toEqual(["ls\r"]);
  expect(sizes).toEqual([[120, 40], [80, 24]]);
});
