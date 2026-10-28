import { describe, expect, test } from "bun:test";
import { parseAnsible } from "./ansible";
import { ImportError } from "./error";

const ini = `
[web]
web1 ansible_host=10.0.0.11
web2

[db]
db1 ansible_connection=winrm ansible_password=FIXTURE-SECRET

[web:vars]
ansible_user=deploy

[prod:children]
web
`;

const yaml = `
all:
  children:
    prod:
      children:
        web:
          vars:
            ansible_user: deploy
          hosts:
            web1:
              ansible_host: 10.0.0.11
            web2: null
    db:
      hosts:
        db1:
          ansible_connection: winrm
          ansible_password: FIXTURE-SECRET
`;

describe("parseAnsible", () => {
  test("ini: children group and vars are applied to the tree", () => {
    const r = parseAnsible(ini);
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x]));
    expect(g.prod.parentKey).toBeNull();
    expect(g.web).toMatchObject({ parentKey: "prod", user: "deploy" });
    expect(r.hosts.find((h) => h.key === "web1")).toMatchObject({ address: "10.0.0.11", parentKey: "web" });
  });

  test("winrm host is windows on port 22", () => {
    const r = parseAnsible(ini);
    expect(r.hosts.find((h) => h.key === "db1")).toMatchObject({ os: "windows", port: 22, parentKey: "db" });
  });

  test("yaml gives the same tree as ini", () => {
    const fromIni = parseAnsible(ini);
    const fromYaml = parseAnsible(yaml);
    // order of groups and hosts follows the file format, so compare sorted by key
    const norm = (t: typeof fromIni) => ({
      groups: [...t.groups].sort((a, b) => a.key.localeCompare(b.key)),
      hosts: [...t.hosts].sort((a, b) => a.key.localeCompare(b.key)),
    });
    expect(norm(fromYaml)).toEqual(norm(fromIni));
  });

  test("password values never reach the result", () => {
    expect(JSON.stringify(parseAnsible(ini))).not.toContain("FIXTURE-SECRET");
    expect(JSON.stringify(parseAnsible(yaml))).not.toContain("FIXTURE-SECRET");
  });

  test("ProxyJump in common args becomes jumpRef.raw", () => {
    const r = parseAnsible(`[x]\nh1 ansible_host=h1.example.test ansible_ssh_common_args='-o ProxyJump=ops@bastion:2222'\n`);
    expect(r.hosts[0].jumpRef).toEqual({ raw: "ops@bastion:2222" });
  });

  test("host in two groups goes to the first with a warning", () => {
    const r = parseAnsible(`[a]\nh1\n[b]\nh1\n`);
    expect(r.hosts).toHaveLength(1);
    expect(r.hosts[0].parentKey).toBe("a");
    expect(r.warnings).toContain("h1 also in b");
  });

  test("empty inventory throws ImportError", () => {
    expect(() => parseAnsible("# nothing here\n")).toThrow(ImportError);
  });
});
