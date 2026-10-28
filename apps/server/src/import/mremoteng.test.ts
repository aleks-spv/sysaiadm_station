import { describe, expect, test } from "bun:test";
import { parseMremoteng } from "./mremoteng";
import { ImportError } from "./error";

const xml = `<?xml version="1.0" encoding="utf-8"?>
<Connections Name="Connections" FullFileEncryption="false">
  <Node Name="Production" Type="Container" Id="g1">
    <Node Name="DB" Type="Connection" Id="h1" Hostname="db.example.com" Protocol="SSH2" Password="FIXTURE-SECRET" Descr="primary"/>
    <Node Name="Win" Type="Connection" Id="h2" Hostname="w.example.test" Protocol="RDP" Port="3389"/>
    <Node Name="Telnet" Type="Connection" Id="h3" Hostname="t.example.test" Protocol="Telnet"/>
  </Node>
</Connections>`;

describe("parseMremoteng", () => {
  test("container becomes group and connection gets its parentKey", () => {
    const r = parseMremoteng(xml);
    expect(r.groups).toEqual([{ key: "g1", name: "Production", parentKey: null }]);
    const db = r.hosts.find((h) => h.key === "h1");
    expect(db).toMatchObject({ address: "db.example.com", parentKey: "g1", os: "other", port: 22 });
  });

  test("rdp is windows on port 22, unknown protocol is skipped with warning", () => {
    const r = parseMremoteng(xml);
    expect(r.hosts.find((h) => h.key === "h2")).toMatchObject({ os: "windows", port: 22 });
    expect(r.hosts.find((h) => h.key === "h3")).toBeUndefined();
    expect(r.warnings).toContain("skipped Telnet: Telnet");
  });

  test("password attribute never reaches the result", () => {
    expect(JSON.stringify(parseMremoteng(xml))).not.toContain("FIXTURE-SECRET");
  });

  test("other root element throws ImportError", () => {
    expect(() => parseMremoteng("<Foo><Node/></Foo>")).toThrow(ImportError);
  });

  test("DOCTYPE is refused", () => {
    const bomb = `<!DOCTYPE Connections [<!ENTITY a "x">]><Connections/>`;
    expect(() => parseMremoteng(bomb)).toThrow(ImportError);
  });

  test("encrypted file is refused", () => {
    expect(() => parseMremoteng(`<Connections FullFileEncryption="true"/>`)).toThrow(/encrypted/);
  });
});
