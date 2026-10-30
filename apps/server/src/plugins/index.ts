import type { ServerPlugin } from "./types";
import { rtkPlugin } from "../../../../plugins/rtk/server";
import { schedulerPlugin } from "../../../../plugins/scheduler/server";
import { secretsPlugin } from "../../../../plugins/secrets/server";
import { terminalPlugin } from "../../../../plugins/terminal/server";
import { wireguardPlugin } from "../../../../plugins/wireguard/server";

// Installed plugins. Each lives in <repo>/plugins/<id> (its own workspace package): server/ exports a ServerPlugin, web/ its page.
export const PLUGINS: ServerPlugin[] = [wireguardPlugin, schedulerPlugin, terminalPlugin, rtkPlugin, secretsPlugin];
