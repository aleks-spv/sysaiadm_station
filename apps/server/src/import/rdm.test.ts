import { describe, expect, test } from "bun:test";
import { parseRdm } from "./rdm";
import { ImportError } from "./error";

const numeric = {
  Connections: [
    { ID: "c1", ConnectionType: 25, Name: "Customers" },
    { ID: "h1", ConnectionType: 77, Name: "web", Host: "host-a", Port: 22, Username: "ops", Group: "Customers\\ACME" },
    { ID: "h2", ConnectionType: 1, Name: "win", Host: "w.example.test", Group: "Customers" },
    { ID: "k1", ConnectionType: 26, Name: "cred", Password: "FIXTURE-SECRET" },
  ],
  Folders: [],
};

const token = {
  Connections: [
    { ID: "c1", ConnectionType: "group", Name: "Customers" },
    { ID: "h1", ConnectionType: "sshshell", Name: "web", Host: "host-a", Port: 22, Username: "ops", Group: "Customers\\ACME" },
    { ID: "h2", ConnectionType: "rdp", Name: "win", Host: "w.example.test", Group: "Customers" },
    { ID: "k1", ConnectionType: "credential", Name: "cred", Password: "FIXTURE-SECRET" },
  ],
};

describe("parseRdm", () => {
  test("numeric and token ConnectionType give the same result", () => {
    expect(parseRdm(JSON.stringify(numeric))).toEqual({ ...parseRdm(JSON.stringify(token)), source: "rdm" });
  });

  test("backslash path builds a parent chain of groups", () => {
    const r = parseRdm(JSON.stringify(numeric));
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x.parentKey]));
    expect(g).toEqual({ Customers: null, "Customers\\ACME": "Customers" });
    expect(r.hosts.find((h) => h.key === "h1")?.parentKey).toBe("Customers\\ACME");
  });

  test("ssh is other, rdp is windows on port 22", () => {
    const r = parseRdm(JSON.stringify(numeric));
    expect(r.hosts.find((h) => h.key === "h1")?.os).toBe("other");
    expect(r.hosts.find((h) => h.key === "h2")).toMatchObject({ os: "windows", port: 22 });
  });

  test("credential record is not in hosts or groups", () => {
    const r = parseRdm(JSON.stringify(numeric));
    expect(r.hosts.find((h) => h.key === "k1")).toBeUndefined();
    expect(r.groups.find((g) => g.key === "k1")).toBeUndefined();
  });

  test("password value never reaches the result", () => {
    expect(JSON.stringify(parseRdm(JSON.stringify(numeric)))).not.toContain("FIXTURE-SECRET");
  });

  test("document without Connections or Folders throws ImportError", () => {
    expect(() => parseRdm('{"foo":1}')).toThrow(ImportError);
    expect(() => parseRdm('{"foo":1}')).toThrow("Export All");
  });
});
