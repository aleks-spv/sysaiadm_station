// Remote commands in flight per task, so Stop kills them directly instead of trusting opencode to cancel the tool.
// shortcut: in-process map, enough for one sysadm process; move to the DB only if sysadm ever runs as several.
const running = new Map<string, Set<AbortController>>();
const commands = new Map<AbortController, string>();

export function trackExec(taskId: string, command = ""): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  let set = running.get(taskId);
  if (!set) running.set(taskId, (set = new Set()));
  set.add(ctrl);
  commands.set(ctrl, command);
  return {
    signal: ctrl.signal,
    done: () => {
      set.delete(ctrl);
      commands.delete(ctrl);
      if (set.size === 0 && running.get(taskId) === set) running.delete(taskId);
    },
  };
}

// True while some approved remote command matching `re` is still running (sysadm-oc proves its call came from one).
export function commandInFlight(re: RegExp): boolean {
  return [...commands.values()].some((command) => re.test(command));
}

// Returns how many commands were aborted.
export function abortTaskExecs(taskId: string): number {
  const set = running.get(taskId);
  if (!set) return 0;
  running.delete(taskId);
  for (const ctrl of set) ctrl.abort();
  return set.size;
}
