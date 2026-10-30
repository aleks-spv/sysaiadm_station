import { Hono } from "hono";
import type { ExecOutputView, FilteredOutput, PluginContext, ServerPlugin } from "../../../apps/server/src/plugins/types";
import { maskSecrets } from "./mask";

export const secretsPlugin: ServerPlugin = {
  id: "secrets",
  name: "Маскировка секретов",
  description: "Заменяет пароли, токены, приватные ключи и хеши паролей в выводе команд на *** до того, как его прочитает модель. Действует и на raw=true.",
  routes: () => new Hono(),
  async maskOutput(ctx: PluginContext, output: ExecOutputView): Promise<FilteredOutput | null> {
    const stdout = maskSecrets(output.stdout);
    const stderr = maskSecrets(output.stderr);
    const count = stdout.count + stderr.count;
    if (count === 0) return null;
    // Count only: the audit must not become a copy of what was hidden.
    ctx.audit("system", "secrets_masked", { count, command: output.command }, { nodeId: output.nodeId, taskId: output.taskId });
    return { stdout: stdout.text, stderr: stderr.text, note: `[скрыто секретов: ${count}; значения заменены на ***, админ видит их в терминале]` };
  },
};
