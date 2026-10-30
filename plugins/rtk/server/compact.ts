// Lossless-first compaction of command output, in the spirit of rtk, for commands rtk has no stdin filter for
// (journalctl, apt, systemctl, docker logs, PowerShell...). Only the head/tail cut drops lines, and it says so.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const HEAD = 150;
const TAIL = 100;
const MAX_LINES = HEAD + TAIL + 50;
const MAX_LINE = 2000;

// The part a terminal would show after carriage returns: progress bars keep only their last state.
function lastFrame(line: string): string {
  if (!line.includes("\r")) return line;
  const frames = line.split("\r").filter((f) => f.length > 0);
  return frames[frames.length - 1] ?? "";
}

export function compact(text: string): string {
  if (!text) return text;
  const lines = text.replace(ANSI, "").replace(/\r\n/g, "\n").split("\n").map((l) => lastFrame(l).trimEnd());

  const out: string[] = [];
  let prev: string | null = null;
  let repeats = 0;
  const flush = () => {
    if (repeats > 0) out.push(`  … строка повторилась ещё ${repeats} раз`);
    repeats = 0;
  };
  for (const raw of lines) {
    const line = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)} … [+${raw.length - MAX_LINE} симв.]` : raw;
    if (line === prev) {
      // Blank runs collapse to one blank line, without a counter.
      if (line !== "") repeats++;
      continue;
    }
    flush();
    out.push(line);
    prev = line;
  }
  flush();
  while (out.length && out[out.length - 1] === "") out.pop();

  if (out.length <= MAX_LINES) return out.join("\n");
  const skipped = out.length - HEAD - TAIL;
  return [...out.slice(0, HEAD), `… пропущено ${skipped} строк (сузь вывод grep/tail/head или повтори с raw=true) …`, ...out.slice(-TAIL)].join("\n");
}

// rtk stdin filters that keep meaning for a sysadmin; others (git log, log) drop too much, auto-detect misreads syslog.
export function pickRtkFilter(command: string): string | null {
  // Several commands' output is mixed; only a single command or the last stage of a pipe is recognised.
  if (/&&|\|\||;|\n/.test(command)) return null;
  const stage = command.split("|").pop()!.trim();
  const words = stage.split(/\s+/).filter((w) => !/^\w+=/.test(w));
  while (words[0] === "sudo" || words[0] === "env" || words[0]?.startsWith("-")) words.shift();
  const [bin, sub] = words;
  const flags = words.slice(1).join(" ");
  if (bin === "git" && (sub === "diff" || sub === "show")) return "git-diff";
  if (bin === "find" || bin === "fd" || bin === "fdfind") return "find";
  if (bin === "rg") return "grep";
  if ((bin === "grep" || bin === "egrep") && /(^|\s)(-\w*[rR]\w*|--recursive)\b/.test(flags)) return "grep";
  return null;
}
