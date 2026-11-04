// Client for /selfadmin/* (apps/server/src/routes/selfadmin.ts); runs as uid 1000 via docker/sysadm-oc.
import { readFileSync } from "node:fs";

const USAGE = `usage: sysadm-oc <command>
  models                 models opencode offers (provider/model)
  providers              providers and whether a key is connected (keys: admin only, Settings -> Providers)
  plugins                opencode plugins and their state
  config                 opencode.json overlay, secrets shown as "<redacted>"
  version                installed and latest opencode
  set-config '<json>'    replace the overlay; "<redacted>" keeps the stored value   [admin approves]
  plugin-add <package>   add an npm plugin, e.g. opencode-foo or @scope/pkg@1.2.3   [admin approves]
  restart                restart opencode; the current task is cut off              [admin approves]
  upgrade                install the latest opencode 2.x and restart                [admin approves]`;

const [cmd, arg] = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

let request: [method: string, path: string, body?: unknown];
switch (cmd) {
  case "models":
  case "providers":
  case "plugins":
  case "config":
  case "version":
    request = ["GET", cmd];
    break;
  case "set-config":
    try {
      request = ["PUT", "config", JSON.parse(arg ?? "")];
    } catch {
      fail("set-config: the argument must be the whole overlay as JSON (see `sysadm-oc config`)");
    }
    break;
  case "plugin-add":
    request = ["POST", "plugins", { package: arg ?? "" }];
    break;
  case "restart":
  case "upgrade":
    request = ["POST", cmd];
    break;
  default:
    fail(USAGE);
}

const { port, token } = JSON.parse(readFileSync("/data/selfadmin.json", "utf8")) as { port: number; token: string };
const [method, path, body] = request!;
const res = await fetch(`http://127.0.0.1:${port}/selfadmin/${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const out = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as unknown;
if (!res.ok) fail(`sysadm-oc ${cmd}: ${(out as { error?: string }).error ?? `HTTP ${res.status}`}`);
if (cmd === "models") for (const m of out as Array<{ id: string; name: string }>) console.log(`${m.id}\t${m.name}`);
else console.log(JSON.stringify(out, null, 2));
