import { describe, expect, test } from "bun:test";
import { parseRustconn } from "./rustconn";
import { ImportError } from "./error";

const doc = {
  version: 3,
  groups: [
    { id: "g1", name: "Company" },
    { id: "g2", name: "pve-01", parent_id: "g1", username: "root" },
    { id: "g3", name: "rack", parent_id: "g2" },
  ],
  connections: [
    {
      id: "bastion",
      name: "bastion",
      host: "host-a",
      port: 2222,
      username: "jump",
      group_id: "g1",
      protocol_config: { type: "Ssh" },
    },
    {
      id: "vm-01",
      name: "vm-01",
      host: "host-b",
      port: 22,
      group_id: "g3",
      description: "db",
      tags: ["prod"],
      protocol_config: { type: "Ssh", jump_host_id: "bastion", key_path: "/keys/id" },
      password: "SECRET-VALUE",
    },
    { id: "win-01", name: "win-01", host: "w.example.test", group_id: "g2", protocol_config: { type: "Rdp" } },
    { id: "vnc-01", name: "vnc-01", host: "v.example.test", protocol_config: { type: "Vnc" } },
  ],
};

describe("parseRustconn", () => {
  const result = parseRustconn(JSON.stringify(doc));

  test("nested groups keep parent chain", () => {
    const g = Object.fromEntries(result.groups.map((x) => [x.key, x.parentKey]));
    expect(g).toEqual({ g1: null, g2: "g1", g3: "g2" });
    expect(result.groups.find((x) => x.key === "g2")?.user).toBe("root");
  });

  test("ssh host with jump_host_id gets jumpRef.key and key hint", () => {
    const vm = result.hosts.find((h) => h.key === "vm-01");
    expect(vm?.jumpRef).toEqual({ key: "bastion" });
    expect(vm?.keyPathHint).toBe("/keys/id");
    expect(vm?.notes).toBe("db\ntags: prod");
    expect(vm?.os).toBe("other");
  });

  test("rdp host is windows on port 22", () => {
    const win = result.hosts.find((h) => h.key === "win-01");
    expect(win?.os).toBe("windows");
    expect(win?.port).toBe(22);
  });

  test("vnc is skipped with a warning", () => {
    expect(result.hosts.find((h) => h.key === "vnc-01")).toBeUndefined();
    expect(result.warnings).toContain("skipped vnc-01: Vnc");
  });

  test("password values never reach the result", () => {
    expect(JSON.stringify(result)).not.toContain("SECRET-VALUE");
  });

  test("garbage input throws ImportError", () => {
    expect(() => parseRustconn("not json")).toThrow(ImportError);
    expect(() => parseRustconn("{}")).toThrow("not a RustConn .rcn file");
  });
});
